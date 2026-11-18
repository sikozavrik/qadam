from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional
import uuid

import models
from database import engine, get_db

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Qadam API", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# pbkdf2_sha256 не требует отдельной сборки bcrypt и работает "из коробки"
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


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
@app.post("/users/{user_id}/subscribe", response_model=UserOut)
def buy_subscription(user_id: int, months: int = 1, db: Session = Depends(get_db)):
    if months not in (1, 3):
        raise HTTPException(status_code=400, detail="Доступны тарифы на 1 или 3 месяца")
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    now = datetime.utcnow()
    # продление идёт от текущей даты окончания, если абонемент ещё действует
    base = user.subscription_until if (user.subscription_until and user.subscription_until > now) else now
    user.subscription_active = True
    user.is_frozen = False
    user.subscription_until = base + timedelta(days=30 * months)
    db.commit()
    db.refresh(user)
    return user


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
    return db.query(models.Studio).order_by(models.Studio.id).all()


@app.post("/studios")
def create_studio(studio: StudioCreate, db: Session = Depends(get_db)):
    db_studio = models.Studio(**studio.model_dump())
    db.add(db_studio)
    db.commit()
    db.refresh(db_studio)
    return db_studio


@app.get("/workouts")
def get_workouts(include_past: bool = False, db: Session = Depends(get_db)):
    q = db.query(models.Workout)
    if not include_past:
        q = q.filter(models.Workout.start_time >= datetime.utcnow())
    return q.order_by(models.Workout.start_time).all()


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
        "message": "Чекин подтверждён! +1 шаг к уровню Qadam",
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


@app.get("/users/{user_id}/stats")
def user_stats(user_id: int, db: Session = Depends(get_db)):
    """Шаги = подтверждённые посещения. Серия = подряд идущие недели с хотя бы одним шагом."""
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

    level_idx = max(i for i, (need, _) in enumerate(LEVELS) if steps >= need)
    next_need = LEVELS[level_idx + 1][0] if level_idx + 1 < len(LEVELS) else None

    badges = []
    if steps >= 1:
        badges.append({"id": "first_step", "title": "Первый шаг", "emoji": "👟"})
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