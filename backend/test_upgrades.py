from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_card_payment_and_badge():
    res = client.post(
        "/payments/card",
        json={
            "phone": "+77059998877",
            "card_number": "4111111111111111",
            "expiry": "12/28",
            "cvv": "123",
            "plan_months": 1,
            "amount_kzt": 14990,
        },
    )
    assert res.status_code == 200
    assert res.json()["status"] == "APPROVED"


def test_schedule_cache_and_reminders():
    s1 = client.get("/studios/schedule")
    s2 = client.get("/studios/schedule")
    assert s1.status_code == 200
    assert s2.json()["source"] == "redis_or_cache"

    r = client.get("/reminders/upcoming")
    assert r.status_code == 200


def test_qr_checkin_flow():
    created = client.post(
        "/bookings/with-qr",
        json={"phone": "+77059998877", "studio": "Qadam Gym", "workout": "Yoga", "minutes_until_start": 45},
    )
    assert created.status_code == 200
    qr_code = created.json()["qr_code"]

    ok_checkin = client.post("/checkin/qr", json={"qr_code": qr_code})
    assert ok_checkin.status_code == 200

    dup_checkin = client.post("/checkin/qr", json={"qr_code": qr_code})
    assert dup_checkin.status_code == 400