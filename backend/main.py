from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional
import asyncio
import json
import os
import re
import time
import uuid
from contextlib import asynccontextmanager

import models
from database import engine, get_db, SessionLocal

models.Base.metadata.create_all(bind=engine)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # фоновая задача автонапоминаний работает, пока запущен сервер
    task = asyncio.create_task(reminder_worker())
    yield
    task.cancel()


app = FastAPI(title="Qadam API", version="1.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# pbkdf2_sha256 не требует отдельной сборки bcrypt и работает "из коробки"
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# ---------------- Кэш: Redis с запасным вариантом в памяти ----------------
try:
    import redis as _redis
except ImportError:
    _redis = None

redis_client = None
if _redis is not None:
    try:
        redis_client = _redis.Redis.from_url(
            os.getenv("REDIS_URL", "redis://localhost:6379/0"),
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        redis_client.ping()
        print("[CACHE] Redis подключён")
    except Exception:
        redis_client = None
        print("[CACHE] Redis недоступен, используется кэш в памяти")

_mem_cache = {}  # ключ -> (время истечения, json-строка)
CACHE_PREFIX = "qadam:"


def cache_get(key: str):
    """Возвращает (значение, источник) или (None, None)."""
    if redis_client is not None:
        try:
            raw = redis_client.get(CACHE_PREFIX + key)
            if raw is not None:
                return json.loads(raw), "redis"
            return None, None
        except Exception:
            pass
    item = _mem_cache.get(key)
    if item and item[0] > time.time():
        return json.loads(item[1]), "memory"
    return None, None


def cache_set(key: str, value, ttl: int):
    raw = json.dumps(value, default=str)
    if redis_client is not None:
        try:
            redis_client.setex(CACHE_PREFIX + key, ttl, raw)
            return
        except Exception:
            pass
    _mem_cache[key] = (time.time() + ttl, raw)


def cache_delete(*keys: str):
    for key in keys:
        _mem_cache.pop(key, None)
        if redis_client is not None:
            try:
                redis_client.delete(CACHE_PREFIX + key)
            except Exception:
                pass


def invalidate_schedule():
    """Сбросить кэш расписания при любом изменении мест или тренировок."""
    cache_delete("schedule", "workouts:upcoming")


# ---------------- Схемы ----------------
class UserRegister(BaseModel):
    full_name: str
    phone: str
    password: str
    # поле role убрано намеренно: клиент не может выбрать роль


class UserLogin(BaseModel):
    phone: str
    password: str


class UserOut(BaseModel):
    """Что отдаём клиенту. password_hash сюда НЕ входит."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    full_name: str
    phone: str
    role: str
    subscription_active: bool
    subscription_until: Optional[datetime] = None
    is_frozen: bool


class StudioCreate(BaseModel):
    name: str
    category: str
    address: str
    description: str = ""


class WorkoutCreate(BaseModel):
    studio_id: int
    title: str
    trainer_name: str
    start_time: datetime
    max_spots: int


class BookingCreate(BaseModel):
    user_id: int
    workout_id: int


# ---------------- Хелперы ----------------
def sync_subscription(user: models.User, db: Session):
    """Если срок абонемента истёк, выключаем его в БД."""
    if user.subscription_active and user.subscription_until and user.subscription_until < datetime.utcnow():
        user.subscription_active = False
        db.commit()
        db.refresh(user)


def is_hashed(value: str) -> bool:
    return value.startswith("$pbkdf2-sha256$")


# ---------------- Авторизация ----------------
@app.post("/auth/register", response_model=UserOut)
def register(user: UserRegister, db: Session = Depends(get_db)):
    if db.query(models.User).filter(models.User.phone == user.phone).first():
        raise HTTPException(status_code=400, detail="Номер телефона уже зарегистрирован")
    new_user = models.User(
        full_name=user.full_name.strip(),
        phone=user.phone.strip(),
        password_hash=pwd_context.hash(user.password),
        role="user",  # роль всегда user, админа можно создать только в БД
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user


@app.post("/auth/login", response_model=UserOut)
def login(creds: UserLogin, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.phone == creds.phone.strip()).first()
    if not user:
        raise HTTPException(status_code=401, detail="Неверный телефон или пароль")

    if is_hashed(user.password_hash):
        ok = pwd_context.verify(creds.password, user.password_hash)
    else:
        # старые пользователи с паролем в открытом виде: проверяем и сразу переводим на хеш
        ok = user.password_hash == creds.password
        if ok:
            user.password_hash = pwd_context.hash(creds.password)
            db.commit()
    if not ok:
        raise HTTPException(status_code=401, detail="Неверный телефон или пароль")

    sync_subscription(user, db)
    return user


@app.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    sync_subscription(user, db)
    return user


@app.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)):
    return db.query(models.User).order_by(models.User.id).all()


# ---------------- Абонемент ----------------
def activate_subscription(user: models.User, months: int):
    """Продлевает абонемент (без commit, коммитит вызывающий код)."""
    now = datetime.utcnow()
    base = user.subscription_until if (user.subscription_until and user.subscription_until > now) else now
    user.subscription_active = True
    user.is_frozen = False
    user.subscription_until = base + timedelta(days=30 * months)


@app.post("/users/{user_id}/freeze", response_model=UserOut)
def toggle_freeze(user_id: int, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user:
        sync_subscription(user, db)
    if not user or not user.subscription_active:
        raise HTTPException(status_code=400, detail="Нет активного абонемента")
    user.is_frozen = not user.is_frozen
    db.commit()
    db.refresh(user)
    return user


# ---------------- Студии и тренировки ----------------
@app.get("/studios")
def get_studios(db: Session = Depends(get_db)):
    cached, _ = cache_get("studios")
    if cached is not None:
        return cached
    data = [
        {
            "id": st.id, "name": st.name, "category": st.category, "address": st.address,
            "description": st.description, "image_url": st.image_url,
        }
        for st in db.query(models.Studio).order_by(models.Studio.id).all()
    ]
    cache_set("studios", data, 60)
    return data


@app.post("/studios")
def create_studio(studio: StudioCreate, db: Session = Depends(get_db)):
    db_studio = models.Studio(**studio.model_dump())
    db.add(db_studio)
    db.commit()
    db.refresh(db_studio)
    cache_delete("studios")
    return db_studio


def workout_dict(w: models.Workout):
    return {
        "id": w.id, "studio_id": w.studio_id, "title": w.title, "trainer_name": w.trainer_name,
        "start_time": w.start_time.isoformat(), "duration_minutes": w.duration_minutes,
        "max_spots": w.max_spots, "booked_spots": w.booked_spots,
    }


@app.get("/workouts")
def get_workouts(include_past: bool = False, db: Session = Depends(get_db)):
    if not include_past:
        cached, _ = cache_get("workouts:upcoming")
        if cached is not None:
            return cached
    q = db.query(models.Workout)
    if not include_past:
        q = q.filter(models.Workout.start_time >= datetime.utcnow())
    data = [workout_dict(w) for w in q.order_by(models.Workout.start_time).all()]
    if not include_past:
        cache_set("workouts:upcoming", data, 15)
    return data


@app.post("/workouts")
def create_workout(workout: WorkoutCreate, db: Session = Depends(get_db)):
    if workout.max_spots < 1:
        raise HTTPException(status_code=400, detail="Количество мест должно быть больше нуля")
    if not db.query(models.Studio).filter(models.Studio.id == workout.studio_id).first():
        raise HTTPException(status_code=404, detail="Студия не найдена")
    db_workout = models.Workout(**workout.model_dump())
    db.add(db_workout)
    db.commit()
    db.refresh(db_workout)
    invalidate_schedule()
    return db_workout


# ---------------- Бронирования ----------------
def booking_out(b, w, s):
    return {
        "id": b.id,
        "status": b.status,
        "qr_code": b.qr_code,
        "created_at": b.created_at,
        "workout_id": b.workout_id,
        "workout_title": w.title if w else None,
        "start_time": w.start_time if w else None,
        "studio_name": s.name if s else None,
    }


@app.post("/bookings")
def book_workout(data: BookingCreate, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == data.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    sync_subscription(user, db)  # коммит делаем ДО блокировки строки тренировки

    # FOR UPDATE: параллельные запросы на последнюю запись выстраиваются в очередь
    workout = (
        db.query(models.Workout)
        .filter(models.Workout.id == data.workout_id)
        .with_for_update()
        .first()
    )
    if not workout:
        raise HTTPException(status_code=404, detail="Тренировка не найдена")
    if not user.subscription_active or user.is_frozen:
        db.rollback()
        raise HTTPException(status_code=403, detail="Требуется активный и незамороженный абонемент Qadam")
    if workout.start_time < datetime.utcnow():
        db.rollback()
        raise HTTPException(status_code=400, detail="Тренировка уже началась или прошла")
    if workout.booked_spots >= workout.max_spots:
        db.rollback()
        raise HTTPException(status_code=400, detail="Свободных мест не осталось")

    existing = db.query(models.Booking).filter(
        models.Booking.user_id == data.user_id,
        models.Booking.workout_id == data.workout_id,
        models.Booking.status.in_(["confirmed", "visited"]),
    ).first()
    if existing:
        db.rollback()
        raise HTTPException(status_code=400, detail="Вы уже записаны на эту тренировку")

    workout.booked_spots += 1
    booking = models.Booking(
        user_id=data.user_id,
        workout_id=data.workout_id,
        qr_code=f"QADAM-{uuid.uuid4().hex[:8].upper()}",
    )
    db.add(booking)
    db.commit()
    db.refresh(booking)
    invalidate_schedule()
    return booking_out(booking, workout, None)


@app.get("/users/{user_id}/bookings")
def get_user_bookings(user_id: int, db: Session = Depends(get_db)):
    rows = (
        db.query(models.Booking, models.Workout, models.Studio)
        .join(models.Workout, models.Booking.workout_id == models.Workout.id)
        .outerjoin(models.Studio, models.Workout.studio_id == models.Studio.id)
        .filter(models.Booking.user_id == user_id)
        .order_by(models.Booking.created_at.desc())
        .all()
    )
    return [booking_out(b, w, s) for b, w, s in rows]


@app.post("/bookings/{booking_id}/cancel")
def cancel_booking(booking_id: int, db: Session = Depends(get_db)):
    booking = db.query(models.Booking).filter(models.Booking.id == booking_id).first()
    if not booking or booking.status != "confirmed":
        raise HTTPException(status_code=400, detail="Бронь нельзя отменить")
    workout = (
        db.query(models.Workout)
        .filter(models.Workout.id == booking.workout_id)
        .with_for_update()
        .first()
    )
    if workout and workout.booked_spots > 0:
        workout.booked_spots -= 1
    booking.status = "cancelled"
    db.commit()
    invalidate_schedule()
    return {"message": "Бронирование отменено"}


@app.post("/bookings/{qr_code}/checkin")
def checkin_booking(qr_code: str, db: Session = Depends(get_db)):
    row = (
        db.query(models.Booking, models.Workout, models.User)
        .join(models.Workout, models.Booking.workout_id == models.Workout.id)
        .join(models.User, models.Booking.user_id == models.User.id)
        .filter(models.Booking.qr_code == qr_code.strip().upper())
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="QR-код не найден")
    booking, workout, user = row
    if booking.status == "visited":
        raise HTTPException(status_code=400, detail="Этот QR-код уже использован")
    if booking.status != "confirmed":
        raise HTTPException(status_code=400, detail="Бронь отменена, вход невозможен")

    booking.status = "visited"
    db.commit()
    return {
        "message": "Чекин подтверждён! +1 qadam алға",
        "user_name": user.full_name,
        "workout_title": workout.title,
    }


# ---------------- Qadam Streak (фишка проекта) ----------------
LEVELS = [
    (0, "Новичок"),
    (5, "Энтузиаст"),
    (15, "Атлет"),
    (30, "Чемпион"),
    (60, "Легенда"),
]


def week_start(dt: datetime):
    return (dt - timedelta(days=dt.weekday())).date()


def streak_data(user_id: int, db: Session):
    """Qadam = подтверждённая тренировка. Серия = подряд идущие недели с хотя бы одним qadam."""
    rows = (
        db.query(models.Workout.start_time, models.Workout.studio_id)
        .join(models.Booking, models.Booking.workout_id == models.Workout.id)
        .filter(models.Booking.user_id == user_id, models.Booking.status == "visited")
        .all()
    )
    steps = len(rows)
    weeks = sorted({week_start(t) for t, _ in rows})
    studios_visited = len({s for _, s in rows})

    # лучшая серия
    best, run, prev = 0, 0, None
    for w in weeks:
        run = run + 1 if prev and (w - prev).days == 7 else 1
        best = max(best, run)
        prev = w

    # текущая серия: считаем назад от этой недели (если на этой ещё нет шага, неделя не прерывает серию)
    this_week = week_start(datetime.utcnow())
    wset = set(weeks)
    cursor = this_week if this_week in wset else this_week - timedelta(days=7)
    current = 0
    while cursor in wset:
        current += 1
        cursor -= timedelta(days=7)
    return steps, current, best, studios_visited


@app.get("/users/{user_id}/stats")
def user_stats(user_id: int, db: Session = Depends(get_db)):
    steps, current, best, studios_visited = streak_data(user_id, db)

    level_idx = max(i for i, (need, _) in enumerate(LEVELS) if steps >= need)
    next_need = LEVELS[level_idx + 1][0] if level_idx + 1 < len(LEVELS) else None

    badges = []
    if steps >= 1:
        badges.append({"id": "first_step", "title": "Первый qadam", "emoji": "👟"})
    if steps >= 5:
        badges.append({"id": "five_steps", "title": "5 тренировок", "emoji": "🔥"})
    if best >= 3:
        badges.append({"id": "streak_3", "title": "3 недели подряд", "emoji": "⚡"})
    if best >= 5:
        badges.append({"id": "streak_5", "title": "5 недель подряд", "emoji": "🏆"})
    if studios_visited >= 3:
        badges.append({"id": "explorer", "title": "Исследователь: 3 студии", "emoji": "🧭"})

    return {
        "steps": steps,
        "current_streak": current,
        "best_streak": best,
        "studios_visited": studios_visited,
        "level": LEVELS[level_idx][1],
        "next_level_at": next_need,
        "badges": badges,
    }


@app.get("/leaderboard")
def leaderboard(db: Session = Depends(get_db)):
    rows = (
        db.query(models.User.id, models.User.full_name, func.count(models.Booking.id).label("steps"))
        .join(models.Booking, models.Booking.user_id == models.User.id)
        .filter(models.Booking.status == "visited", models.User.role == "user")
        .group_by(models.User.id, models.User.full_name)
        .order_by(func.count(models.Booking.id).desc())
        .limit(10)
        .all()
    )
    return [{"user_id": r.id, "full_name": r.full_name, "steps": r.steps} for r in rows]


# ---------------- Статистика для админа ----------------
@app.get("/admin/stats")
def admin_stats(db: Session = Depends(get_db)):
    return {
        "users": db.query(func.count(models.User.id)).filter(models.User.role == "user").scalar(),
        "active_subscriptions": db.query(func.count(models.User.id)).filter(
            models.User.subscription_active.is_(True), models.User.subscription_until > datetime.utcnow()
        ).scalar(),
        "studios": db.query(func.count(models.Studio.id)).scalar(),
        "workouts": db.query(func.count(models.Workout.id)).scalar(),
        "bookings": db.query(func.count(models.Booking.id)).scalar(),
        "visited": db.query(func.count(models.Booking.id)).filter(models.Booking.status == "visited").scalar(),
    }



# ======================================================================
# Qadam+ : эндпоинты для панели UpgradesPanel
# (оплата картой, QR-бронь, чек-ин, бейджи, кэш расписания, напоминания)
# ======================================================================
SCHEDULE_TTL = 30  # секунд
PLAN_PRICES = {1: 14990, 3: 39990}  # цены тарифов в тенге


def luhn_ok(num: str) -> bool:
    if not re.fullmatch(r"\d{13,19}", num):
        return False
    total, alt = 0, False
    for ch in reversed(num):
        n = int(ch)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def expiry_ok(value: str) -> bool:
    m = re.fullmatch(r"(\d{2})/(\d{2})", value.strip())
    if not m:
        return False
    month, year = int(m.group(1)), 2000 + int(m.group(2))
    if not 1 <= month <= 12:
        return False
    # карта действует до конца указанного месяца
    end = datetime(year + (month == 12), (month % 12) + 1, 1)
    return end > datetime.utcnow()


def user_by_phone(phone: str, db: Session) -> models.User:
    user = db.query(models.User).filter(models.User.phone == phone.strip()).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь с таким телефоном не найден")
    return user


class CardPayment(BaseModel):
    phone: str
    card_number: str
    expiry: str
    cvv: str
    plan_months: int = 1
    amount_kzt: int = 14990


class QuickBooking(BaseModel):
    phone: str
    studio: str = "Qadam Gym Almaty"
    workout: str = "HIIT & Core"
    minutes_until_start: int = 60


class QrCheckin(BaseModel):
    qr_code: str


@app.post("/payments/card")
def pay_by_card(data: CardPayment, db: Session = Depends(get_db)):
    user = user_by_phone(data.phone, db)
    if data.plan_months not in PLAN_PRICES:
        raise HTTPException(status_code=400, detail="Доступны тарифы на 1 или 3 месяца")
    digits = re.sub(r"\s", "", data.card_number)
    if not luhn_ok(digits):
        raise HTTPException(status_code=400, detail="Неверный номер карты")
    if not expiry_ok(data.expiry):
        raise HTTPException(status_code=400, detail="Неверный или истёкший срок действия карты")
    if not re.fullmatch(r"\d{3,4}", data.cvv.strip()):
        raise HTTPException(status_code=400, detail="Неверный CVV")

    amount = PLAN_PRICES[data.plan_months]  # цену определяет сервер, а не клиент
    activate_subscription(user, data.plan_months)
    payment = models.Payment(
        user_id=user.id,
        tx_id=f"TXN-{uuid.uuid4().hex[:8].upper()}",
        amount_kzt=amount,
        plan_months=data.plan_months,
        card_last4=digits[-4:],
        status="paid",
    )
    db.add(payment)
    db.commit()  # абонемент и платёж сохраняются одной транзакцией
    db.refresh(user)
    return {
        "payment": {"tx_id": payment.tx_id, "amount_kzt": amount, "status": "paid"},
        "subscription": {"subscription_until": user.subscription_until.isoformat()},
    }


@app.get("/users/{user_id}/payments")
def user_payments(user_id: int, db: Session = Depends(get_db)):
    rows = (
        db.query(models.Payment)
        .filter(models.Payment.user_id == user_id)
        .order_by(models.Payment.created_at.desc())
        .limit(20)
        .all()
    )
    return [
        {
            "id": p.id, "tx_id": p.tx_id, "amount_kzt": p.amount_kzt, "plan_months": p.plan_months,
            "card_last4": p.card_last4, "status": p.status, "created_at": p.created_at,
        }
        for p in rows
    ]


@app.get("/studios/schedule")
def studios_schedule(db: Session = Depends(get_db)):
    """Расписание с кэшем. source: redis | memory | database."""
    cached, backend = cache_get("schedule")
    if cached is not None:
        return {"source": backend, "items": cached}
    rows = (
        db.query(models.Workout, models.Studio)
        .outerjoin(models.Studio, models.Workout.studio_id == models.Studio.id)
        .filter(models.Workout.start_time >= datetime.utcnow())
        .order_by(models.Workout.start_time)
        .limit(8)
        .all()
    )
    items = [
        {
            "id": w.id,
            "time": w.start_time.strftime("%d.%m %H:%M"),
            "title": w.title,
            "studio": st.name if st else "—",
            "spots_left": max(w.max_spots - w.booked_spots, 0),
            "spots_total": w.max_spots,
        }
        for w, st in rows
    ]
    cache_set("schedule", items, SCHEDULE_TTL)
    return {"source": "database", "items": items}


@app.get("/cache/status")
def cache_status():
    return {"backend": "redis" if redis_client is not None else "memory", "redis_connected": redis_client is not None}


@app.get("/users/{phone}/badges")
def user_badges(phone: str, db: Session = Depends(get_db)):
    user = user_by_phone(phone, db)
    sync_subscription(user, db)
    any_booking = db.query(models.Booking.id).filter(models.Booking.user_id == user.id).first() is not None
    steps, _, best, _ = streak_data(user.id, db)
    return {
        "badges": [
            {"id": "first", "title": "Первый qadam", "description": "Создана первая бронь тренировки в Qadam", "unlocked": any_booking},
            {"id": "in_game", "title": "В игре", "description": "Оформлен активный абонемент Qadam", "unlocked": bool(user.subscription_active)},
            {"id": "checkin", "title": "Чек-ин мастер", "description": "Подтверждён вход в зал по QR-коду", "unlocked": steps >= 1},
            {"id": "streak", "title": "Железный стрик", "description": "3 недели подряд с тренировками", "unlocked": best >= 3},
        ]
    }


@app.post("/bookings/with-qr")
def booking_with_qr(data: QuickBooking, db: Session = Depends(get_db)):
    user = user_by_phone(data.phone, db)
    sync_subscription(user, db)
    if not user.subscription_active or user.is_frozen:
        raise HTTPException(status_code=403, detail="Требуется активный и незамороженный абонемент Qadam")
    studio = db.query(models.Studio).filter(models.Studio.name == data.studio).first()
    if not studio:
        studio = models.Studio(name=data.studio, category="Gym", address="Almaty", description="")
        db.add(studio)
        db.flush()
    minutes = max(1, min(data.minutes_until_start, 24 * 60))
    workout = models.Workout(
        studio_id=studio.id,
        title=data.workout,
        trainer_name="Qadam Coach",
        start_time=datetime.utcnow() + timedelta(minutes=minutes),
        max_spots=16,
        booked_spots=1,
    )
    db.add(workout)
    db.flush()
    booking = models.Booking(
        user_id=user.id,
        workout_id=workout.id,
        qr_code=f"QADAM-{uuid.uuid4().hex[:8].upper()}",
    )
    db.add(booking)
    db.commit()
    db.refresh(booking)
    invalidate_schedule()
    return booking_out(booking, workout, studio)


@app.post("/checkin/qr")
def checkin_by_qr(data: QrCheckin, db: Session = Depends(get_db)):
    return checkin_booking(data.qr_code, db)


@app.get("/reminders/upcoming")
def upcoming_reminders(phone: Optional[str] = None, db: Session = Depends(get_db)):
    now = datetime.utcnow()
    q = (
        db.query(models.Booking, models.Workout, models.Studio, models.User)
        .join(models.Workout, models.Booking.workout_id == models.Workout.id)
        .outerjoin(models.Studio, models.Workout.studio_id == models.Studio.id)
        .join(models.User, models.Booking.user_id == models.User.id)
        .filter(
            models.Booking.status == "confirmed",
            models.Workout.start_time >= now,
            models.Workout.start_time <= now + timedelta(hours=3),
        )
    )
    if phone:
        q = q.filter(models.User.phone == phone.strip())
    reminders = []
    for b, w, s, _ in q.order_by(models.Workout.start_time).all():
        mins = int((w.start_time - now).total_seconds() // 60)
        reminders.append({
            "booking_id": b.id,
            "message": f"Напоминание: тренировка «{w.title}» в {s.name if s else 'студии'} начнётся через ~{mins} мин. Код QR: {b.qr_code}",
        })
    return {"reminders": reminders}



# ---------------- Автонапоминания (фоновая задача) ----------------
REMINDER_WINDOW_MIN = 60   # за сколько минут до начала напоминать
REMINDER_EVERY_SEC = 60    # как часто проверять
_sent_reminders = set()    # id броней, по которым напоминание уже отправлено
reminder_log = []          # последние отправленные напоминания (для демонстрации)


def send_due_reminders():
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        rows = (
            db.query(models.Booking, models.Workout, models.Studio, models.User)
            .join(models.Workout, models.Booking.workout_id == models.Workout.id)
            .outerjoin(models.Studio, models.Workout.studio_id == models.Studio.id)
            .join(models.User, models.Booking.user_id == models.User.id)
            .filter(
                models.Booking.status == "confirmed",
                models.Workout.start_time >= now,
                models.Workout.start_time <= now + timedelta(minutes=REMINDER_WINDOW_MIN),
            )
            .all()
        )
        for b, w, st, u in rows:
            if b.id in _sent_reminders:
                continue
            _sent_reminders.add(b.id)
            mins = int((w.start_time - now).total_seconds() // 60)
            msg = f"Тренировка «{w.title}» ({st.name if st else 'студия'}) начнётся через ~{mins} мин. Код QR: {b.qr_code}"
            reminder_log.append({"booking_id": b.id, "phone": u.phone, "message": msg, "sent_at": now.isoformat()})
            del reminder_log[:-50]
            # здесь подключается SMS/Telegram; в MVP уведомление пишется в консоль сервера
            print(f"[REMINDER -> {u.phone}] {msg}")
    finally:
        db.close()


async def reminder_worker():
    while True:
        try:
            await asyncio.to_thread(send_due_reminders)
        except Exception as e:
            print("[REMINDER] ошибка:", e)
        await asyncio.sleep(REMINDER_EVERY_SEC)


@app.get("/reminders/log")
def reminders_log():
    return {"sent": reminder_log}
