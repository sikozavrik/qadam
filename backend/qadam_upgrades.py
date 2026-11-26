import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

try:
    import redis.asyncio as aioredis
except ImportError:
    aioredis = None

router = APIRouter(tags=["Qadam Upgrades"])

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
_redis_client = None
_memory_cache: Dict[str, tuple[float, Any]] = {}

# Временное хранилище в памяти для быстрого запуска без риска затереть ваши модели
# При наличии реальной БД в проекте эти словари легко синхронизируются с вашими таблицами
PAYMENTS_DB: List[Dict[str, Any]] = []
SUBSCRIPTIONS_DB: Dict[str, Dict[str, Any]] = {}
BOOKINGS_DB: Dict[int, Dict[str, Any]] = {
    101: {
        "id": 101,
        "phone": "+77059998877",
        "studio": "Qadam Gym Almaty",
        "workout": "Morning Strength & Mobility",
        "start_time": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
        "qr_code": "QADAM-BK-101-DEMO",
        "checked_in": False,
        "checked_in_at": None,
    }
}
REMINDERS_LOG: List[Dict[str, Any]] = []

SCHEDULE_DATA: List[Dict[str, Any]] = [
    {
        "id": 1,
        "studio": "Qadam Gym Almaty",
        "category": "Gym",
        "title": "Functional Strength",
        "trainer": "Данияр К.",
        "time": "18:30",
        "spots_total": 16,
        "spots_left": 5,
    },
    {
        "id": 2,
        "studio": "Alatau Yoga Loft",
        "category": "Yoga",
        "title": "Vinyasa Flow & Breath",
        "trainer": "Асель М.",
        "time": "19:30",
        "spots_total": 12,
        "spots_left": 3,
    },
    {
        "id": 3,
        "studio": "Peak CrossFit Box",
        "category": "CrossFit",
        "title": "WOD Conditioning",
        "trainer": "Тимур С.",
        "time": "20:00",
        "spots_total": 14,
        "spots_left": 7,
    },
]


# --- 1. БАНКОВСКАЯ ОПЛАТА ---
class CardPaymentRequest(BaseModel):
    phone: str = Field(..., min_length=6)
    card_number: str = Field(..., min_length=12, max_length=23)
    expiry: str = Field(..., pattern=r"^(0[1-9]|1[0-2])\/\d{2}$")
    cvv: str = Field(..., pattern=r"^\d{3,4}$")
    plan_months: int = Field(default=1, ge=1, le=12)
    amount_kzt: int = Field(default=14990, gt=0)


def luhn_check(card_number: str) -> bool:
    digits = [int(ch) for ch in card_number if ch.isdigit()]
    if len(digits) < 12:
        return False
    checksum = 0
    parity = len(digits) % 2
    for idx, digit in enumerate(digits):
        if idx % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        checksum += digit
    return checksum % 10 == 0


def is_expiry_valid(expiry: str) -> bool:
    month_str, year_str = expiry.split("/")
    month = int(month_str)
    year = 2000 + int(year_str)
    now = datetime.now(timezone.utc)
    if year < now.year or (year == now.year and month < now.month):
        return False
    return True


@router.post("/payments/card")
async def process_card_payment(payload: CardPaymentRequest):
    clean_digits = "".join(ch for ch in payload.card_number if ch.isdigit())
    if not luhn_check(clean_digits):
        raise HTTPException(status_code=400, detail="Некорректный номер банковской карты (ошибка проверки Луна)")
    if not is_expiry_valid(payload.expiry):
        raise HTTPException(status_code=400, detail="Срок действия банковской карты истёк")

    tx_id = f"TXN-{uuid.uuid4().hex[:8].upper()}"
    now = datetime.now(timezone.utc)
    current_sub = SUBSCRIPTIONS_DB.get(payload.phone)
    base_date = now
    if current_sub and current_sub.get("subscription_until"):
        prev_dt = datetime.fromisoformat(current_sub["subscription_until"])
        if prev_dt > now:
            base_date = prev_dt

    new_until = base_date + timedelta(days=30 * payload.plan_months)
    SUBSCRIPTIONS_DB[payload.phone] = {
        "phone": payload.phone,
        "subscription_active": True,
        "subscription_until": new_until.isoformat(),
        "is_frozen": False,
        "last_tx_id": tx_id,
    }

    payment_record = {
        "tx_id": tx_id,
        "phone": payload.phone,
        "card_last4": clean_digits[-4:],
        "amount_kzt": payload.amount_kzt,
        "plan_months": payload.plan_months,
        "status": "APPROVED",
        "created_at": now.isoformat(),
    }
    PAYMENTS_DB.append(payment_record)

    return {
        "status": "APPROVED",
        "message": "Банковская оплата прошла успешно, подписка активирована",
        "payment": payment_record,
        "subscription": SUBSCRIPTIONS_DB[payload.phone],
    }


@router.get("/subscriptions/{phone}")
async def get_subscription_status(phone: str):
    sub = SUBSCRIPTIONS_DB.get(phone)
    if not sub:
        return {
            "phone": phone,
            "subscription_active": False,
            "subscription_until": None,
            "is_frozen": False,
        }
    return sub


# --- 2. REDIS-КЭШ РАСПИСАНИЯ СТУДИЙ ---
async def get_redis():
    global _redis_client
    if aioredis is None:
        return None
    if _redis_client is None:
        try:
            client = aioredis.from_url(REDIS_URL, decode_responses=True)
            await client.ping()
            _redis_client = client
        except Exception:
            return None
    return _redis_client


async def cache_get(key: str) -> Optional[Any]:
    client = await get_redis()
    if client:
        raw = await client.get(key)
        if raw:
            return json.loads(raw)
    item = _memory_cache.get(key)
    if item and item[0] > time.time():
        return item[1]
    return None


async def cache_set(key: str, value: Any, ttl_seconds: int = 120) -> None:
    client = await get_redis()
    if client:
        await client.setex(key, ttl_seconds, json.dumps(value))
    _memory_cache[key] = (time.time() + ttl_seconds, value)


async def cache_invalidate(key: str) -> None:
    client = await get_redis()
    if client:
        await client.delete(key)
    _memory_cache.pop(key, None)


@router.get("/studios/schedule")
async def get_studios_schedule(category: Optional[str] = None):
    cache_key = f"qadam:schedule:{category or 'all'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return {"source": "redis_or_cache", "items": cached}

    items = SCHEDULE_DATA
    if category and category.lower() != "all":
        items = [s for s in SCHEDULE_DATA if s["category"].lower() == category.lower()]

    await cache_set(cache_key, items, ttl_seconds=120)
    return {"source": "database_fresh", "items": items}


# --- 3. АВТОНАПОМИНАНИЯ О ТРЕНИРОВКАХ ---
async def run_reminders_tick() -> List[Dict[str, Any]]:
    now = datetime.now(timezone.utc)
    generated = []
    for booking in BOOKINGS_DB.values():
        if booking.get("checked_in"):
            continue
        start_dt = datetime.fromisoformat(booking["start_time"])
        minutes_left = int((start_dt - now).total_seconds() // 60)
        if 0 <= minutes_left <= 180:
            reminder = {
                "booking_id": booking["id"],
                "phone": booking["phone"],
                "message": f"Напоминание: тренировка «{booking['workout']}» в {booking['studio']} начнётся через ~{minutes_left} мин. Код QR: {booking['qr_code']}",
                "sent_at": now.isoformat(),
            }
            REMINDERS_LOG.append(reminder)
            generated.append(reminder)
    return generated


@router.get("/reminders/upcoming")
async def get_upcoming_reminders():
    triggered = await run_reminders_tick()
    return {
        "triggered_now": len(triggered),
        "reminders": REMINDERS_LOG[-10:],
    }


async def reminders_background_worker():
    while True:
        try:
            await run_reminders_tick()
        except Exception:
            pass
        await asyncio.sleep(300)


# --- 4. РАБОЧИЙ QR-КОД И ЧЕК-ИН ---
class BookingCreateRequest(BaseModel):
    phone: str
    studio: str = "Qadam Gym Almaty"
    workout: str = "Evening Conditioning"
    minutes_until_start: int = 90


@router.post("/bookings/with-qr")
async def create_booking_with_qr(req: BookingCreateRequest):
    new_id = max(BOOKINGS_DB.keys(), default=100) + 1
    qr_code = f"QADAM-BK-{new_id}-{uuid.uuid4().hex[:4].upper()}"
    start_time = (datetime.now(timezone.utc) + timedelta(minutes=req.minutes_until_start)).isoformat()
    booking = {
        "id": new_id,
        "phone": req.phone,
        "studio": req.studio,
        "workout": req.workout,
        "start_time": start_time,
        "qr_code": qr_code,
        "checked_in": False,
        "checked_in_at": None,
    }
    BOOKINGS_DB[new_id] = booking
    await cache_invalidate("qadam:schedule:all")
    return booking


@router.get("/bookings/{booking_id}/qr")
async def get_booking_qr(booking_id: int):
    booking = BOOKINGS_DB.get(booking_id)
    if not booking:
        raise HTTPException(status_code=404, detail="Бронирование не найдено")
    qr_payload = json.dumps(
        {
            "booking_id": booking["id"],
            "qr_code": booking["qr_code"],
            "phone": booking["phone"],
            "workout": booking["workout"],
        },
        ensure_ascii=False,
    )
    return {
        "booking_id": booking["id"],
        "qr_code": booking["qr_code"],
        "qr_payload": qr_payload,
        "checked_in": booking["checked_in"],
    }


class QrCheckinRequest(BaseModel):
    qr_code: str


@router.post("/checkin/qr")
async def checkin_by_qr(req: QrCheckinRequest):
    for booking in BOOKINGS_DB.values():
        if booking["qr_code"].strip().upper() == req.qr_code.strip().upper():
            if booking["checked_in"]:
                raise HTTPException(status_code=400, detail="Этот QR-код уже использован для входа")
            booking["checked_in"] = True
            booking["checked_in_at"] = datetime.now(timezone.utc).isoformat()
            return {
                "status": "CHECKED_IN",
                "message": f"Вход подтверждён: {booking['workout']} ({booking['studio']})",
                "booking": booking,
            }
    raise HTTPException(status_code=404, detail="QR-код не найден")


# --- 5. БЕЙДЖИ (ГЕЙМИФИКАЦИЯ) ---
@router.get("/users/{phone}/badges")
async def get_user_badges(phone: str):
    user_payments = [p for p in PAYMENTS_DB if p["phone"] == phone]
    user_bookings = [b for b in BOOKINGS_DB.values() if b["phone"] == phone]
    checkins_count = sum(1 for b in user_bookings if b["checked_in"])

    badges = [
        {
            "id": "first_step",
            "title": "Первый шаг",
            "description": "Создано первое бронирование тренировки в Qadam",
            "unlocked": len(user_bookings) >= 1,
        },
        {
            "id": "pro_pass",
            "title": "В игре",
            "description": "Оформлена и оплачена подписка банковской картой",
            "unlocked": len(user_payments) >= 1,
        },
        {
            "id": "qr_master",
            "title": "Чек-ин мастер",
            "description": "Подтверждён вход в зал через QR-код",
            "unlocked": checkins_count >= 1,
        },
        {
            "id": "streak_3",
            "title": "Железный стрик",
            "description": "3 и более активности (оплаты, бронирования или визиты)",
            "unlocked": (len(user_payments) + len(user_bookings) + checkins_count) >= 3,
        },
    ]
    return {
        "phone": phone,
        "unlocked_count": sum(1 for b in badges if b["unlocked"]),
        "total_count": len(badges),
        "badges": badges,
    }