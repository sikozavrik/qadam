import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { CreditCard, QrCode, Award, CalendarClock, Bell, Lock, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";

const API_BASE = "http://127.0.0.1:8000";

const api = async (path, options) => {
  try {
    const res = await fetch(`${API_BASE}${path}`, options);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { detail: "Нет связи с сервером" } };
  }
};

const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const inputCls =
  "w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 transition";
const cardCls = "bg-slate-900/60 border border-slate-800 rounded-3xl p-6 md:p-8 shadow-xl backdrop-blur-xl";

function Msg({ msg }) {
  if (!msg) return null;
  const ok = msg.type === "success";
  return (
    <div
      className={`flex items-start gap-2 text-sm font-semibold rounded-2xl px-4 py-3 border ${
        ok ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-red-500/10 border-red-500/30 text-red-300"
      }`}
    >
      {ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      <span>{msg.text}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, color = "text-emerald-400", children, action }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-5">
      <h3 className="text-xl font-black tracking-tight flex items-center gap-3">
        <span className={`p-2.5 rounded-xl bg-slate-950 border border-slate-800 ${color}`}>
          <Icon className="w-5 h-5" />
        </span>
        {children}
      </h3>
      {action}
    </div>
  );
}

export default function UpgradesPanel({ defaultPhone = "+77059998877", onChange }) {
  const [phone, setPhone] = useState(defaultPhone);

  const [cardNumber, setCardNumber] = useState("4111 1111 1111 1111");
  const [expiry, setExpiry] = useState("12/28");
  const [cvv, setCvv] = useState("123");
  const [paying, setPaying] = useState(false);
  const [paymentMsg, setPaymentMsg] = useState(null);

  const [schedule, setSchedule] = useState([]);
  const [cacheSource, setCacheSource] = useState("");

  const [qrCodeText, setQrCodeText] = useState("");
  const [qrImageUrl, setQrImageUrl] = useState("");
  const [checkinMsg, setCheckinMsg] = useState(null);

  const [badges, setBadges] = useState([]);
  const [reminders, setReminders] = useState([]);

  const notifyParent = () => onChange && onChange();

  const renderQr = async (text) => {
    setQrCodeText(text);
    if (!text) {
      setQrImageUrl("");
      return;
    }
    try {
      const url = await QRCode.toDataURL(text, { width: 220, margin: 1 });
      setQrImageUrl(url);
    } catch {
      setQrImageUrl("");
    }
  };

  const loadSchedule = async () => {
    const { ok, data } = await api("/studios/schedule");
    if (ok) {
      setSchedule(data.items || []);
      setCacheSource(data.source || "");
    }
  };

  const loadBadges = async (target = phone) => {
    const { ok, data } = await api(`/users/${encodeURIComponent(target)}/badges`);
    setBadges(ok ? data.badges || [] : []);
  };

  const loadReminders = async (target = phone) => {
    const { ok, data } = await api(`/reminders/upcoming?phone=${encodeURIComponent(target)}`);
    setReminders(ok ? data.reminders || [] : []);
  };

  useEffect(() => {
    loadSchedule();
    loadBadges(phone);
    loadReminders(phone);
  }, []);

  const handlePay = async (e) => {
    e.preventDefault();
    setPaymentMsg(null);
    setPaying(true);
    const { ok, data } = await post("/payments/card", {
      phone,
      card_number: cardNumber.replace(/\s/g, ""),
      expiry,
      cvv,
      plan_months: 1,
      amount_kzt: 14990,
    });
    setPaying(false);
    if (!ok) {
      setPaymentMsg({ type: "error", text: data.detail || "Оплата отклонена" });
      return;
    }
    setPaymentMsg({
      type: "success",
      text: `Оплачено (${data.payment.tx_id}). Подписка активна до ${data.subscription.subscription_until.slice(0, 10)}`,
    });
    await loadBadges(phone);
    notifyParent();
  };

  const handleCreateBookingAndQr = async () => {
    setCheckinMsg(null);
    const { ok, data } = await post("/bookings/with-qr", {
      phone,
      studio: "Qadam Gym Almaty",
      workout: "HIIT & Core",
      minutes_until_start: 60,
    });
    if (!ok) {
      setCheckinMsg({ type: "error", text: data.detail || "Не удалось создать бронь" });
      return;
    }
    await renderQr(data.qr_code);
    setCheckinMsg({ type: "success", text: `Бронь создана, ваш код: ${data.qr_code}` });
    await Promise.all([loadBadges(phone), loadReminders(phone), loadSchedule()]);
    notifyParent();
  };

  const handleCheckin = async () => {
    setCheckinMsg(null);
    if (!qrCodeText.trim()) {
      setCheckinMsg({ type: "error", text: "Сначала создайте бронь или введите код" });
      return;
    }
    const { ok, data } = await post("/checkin/qr", { qr_code: qrCodeText.trim() });
    if (!ok) {
      setCheckinMsg({ type: "error", text: data.detail || "Ошибка чекина" });
      return;
    }
    setCheckinMsg({ type: "success", text: data.message });
    await loadBadges(phone);
    notifyParent();
  };

  return (
    <div className="space-y-8">
      {/* Аккаунт, для которого выполняются операции */}
      <div className={`${cardCls} flex flex-col sm:flex-row sm:items-center gap-4`}>
        <div className="flex-1">
          <div className="text-slate-400 text-xs font-bold uppercase tracking-wider">Аккаунт</div>
          <div className="text-slate-500 text-xs mt-1">Все операции ниже выполняются для этого номера</div>
        </div>
        <input
          className={`${inputCls} sm:max-w-xs font-mono`}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => {
            loadBadges(phone);
            loadReminders(phone);
          }}
          placeholder="+77059998877"
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* 1. Оплата */}
        <form onSubmit={handlePay} className={`${cardCls} space-y-4`}>
          <SectionTitle icon={CreditCard}>Оплата абонемента</SectionTitle>
          <input
            className={`${inputCls} font-mono tracking-widest`}
            value={cardNumber}
            onChange={(e) =>
              setCardNumber(e.target.value.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim())
            }
            placeholder="Номер карты"
            inputMode="numeric"
          />
          <div className="grid grid-cols-2 gap-4">
            <input
              className={inputCls}
              value={expiry}
              onChange={(e) => {
                let v = e.target.value.replace(/\D/g, "").slice(0, 4);
                if (v.length > 2) v = v.slice(0, 2) + "/" + v.slice(2);
                setExpiry(v);
              }}
              placeholder="MM/YY"
              inputMode="numeric"
            />
            <input
              className={inputCls}
              value={cvv}
              onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="CVV"
              inputMode="numeric"
              type="password"
            />
          </div>
          <button
            type="submit"
            disabled={paying}
            className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 font-black py-3.5 rounded-2xl transition shadow-lg shadow-emerald-500/20"
          >
            {paying ? "Обработка..." : "Оплатить 14 990 ₸"}
          </button>
          <Msg msg={paymentMsg} />
        </form>

        {/* 2. QR и чекин */}
        <div className={`${cardCls} space-y-4`}>
          <SectionTitle icon={QrCode} color="text-cyan-400">Рабочий QR-код и вход в зал</SectionTitle>
          <div className="flex flex-col sm:flex-row gap-5 items-center sm:items-start">
            <div className="w-44 h-44 shrink-0 bg-white rounded-2xl p-2 flex items-center justify-center shadow-lg">
              {qrImageUrl ? (
                <img src={qrImageUrl} alt="QR Code" className="w-full h-full" />
              ) : (
                <span className="text-slate-400 text-xs text-center px-3">QR появится после создания брони</span>
              )}
            </div>
            <div className="flex-1 w-full space-y-3">
              <div className="text-xs text-slate-400 font-bold uppercase tracking-wider">Код бронирования</div>
              <input
                className={`${inputCls} font-mono tracking-widest`}
                value={qrCodeText}
                onChange={(e) => renderQr(e.target.value.toUpperCase())}
                placeholder="QADAM-XXXXXXXX"
              />
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handleCreateBookingAndQr}
                  className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold py-3 rounded-2xl text-sm transition"
                >
                  Новая бронь + QR
                </button>
                <button
                  type="button"
                  onClick={handleCheckin}
                  className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-3 rounded-2xl text-sm transition"
                >
                  Отметить вход
                </button>
              </div>
            </div>
          </div>
          <Msg msg={checkinMsg} />
        </div>
      </div>

      {/* 3. Бейджи */}
      <div className={cardCls}>
        <SectionTitle
          icon={Award}
          color="text-purple-400"
          action={
            <button
              onClick={() => loadBadges(phone)}
              className="text-xs font-bold text-slate-400 hover:text-white flex items-center gap-1.5 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Обновить
            </button>
          }
        >
          Бейджи
        </SectionTitle>
        {badges.length === 0 ? (
          <p className="text-slate-500 text-sm">Бейджи появятся после загрузки данных аккаунта.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {badges.map((b) => (
              <div
                key={b.id}
                className={`rounded-2xl p-5 border transition ${
                  b.unlocked
                    ? "bg-emerald-500/10 border-emerald-500/40 shadow-lg shadow-emerald-500/5"
                    : "bg-slate-950/60 border-slate-800 opacity-60"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="font-black text-sm">{b.title}</div>
                  {b.unlocked ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Lock className="w-4 h-4 text-slate-500" />}
                </div>
                <div className="text-xs text-slate-400 leading-relaxed">{b.description}</div>
                <div className={`text-xs font-bold mt-3 ${b.unlocked ? "text-emerald-400" : "text-slate-500"}`}>
                  {b.unlocked ? "Открыт" : "Закрыт"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* 4. Расписание с кэшем */}
        <div className={cardCls}>
          <SectionTitle
            icon={CalendarClock}
            color="text-orange-400"
            action={
              <button
                onClick={loadSchedule}
                className="text-xs font-bold text-slate-400 hover:text-white flex items-center gap-1.5 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Обновить
              </button>
            }
          >
            Расписание
          </SectionTitle>
          <div className="text-xs text-slate-500 -mt-3 mb-4">
            Источник данных:{" "}
            <span className={`font-mono font-bold ${cacheSource === "database" ? "text-emerald-400" : "text-orange-400"}`}>
              {cacheSource === "redis"
                ? "Redis (из кэша)"
                : cacheSource === "memory"
                ? "кэш в памяти (Redis не подключён)"
                : cacheSource === "database"
                ? "база данных (кэш обновлён)"
                : "..."}
            </span>
          </div>
          {schedule.length === 0 ? (
            <p className="text-slate-500 text-sm">Ближайших тренировок пока нет.</p>
          ) : (
            <div className="space-y-3">
              {schedule.map((s) => {
                const pct = s.spots_total ? Math.round(((s.spots_total - s.spots_left) / s.spots_total) * 100) : 0;
                return (
                  <div key={s.id} className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                    <div className="flex justify-between gap-3 text-sm">
                      <div>
                        <div className="font-bold">{s.title}</div>
                        <div className="text-xs text-slate-400">
                          {s.time} · {s.studio}
                        </div>
                      </div>
                      <div className="text-xs text-slate-400 text-right shrink-0">
                        Мест: <span className="text-white font-bold">{s.spots_left}</span>/{s.spots_total}
                      </div>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full mt-3 overflow-hidden">
                      <div
                        className={`h-full transition-all ${pct >= 90 ? "bg-red-400" : "bg-emerald-400"}`}
                        style={{ width: `${pct}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 5. Напоминания */}
        <div className={cardCls}>
          <SectionTitle
            icon={Bell}
            color="text-amber-400"
            action={
              <button
                onClick={() => loadReminders(phone)}
                className="text-xs font-bold text-slate-400 hover:text-white flex items-center gap-1.5 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Проверить
              </button>
            }
          >
            Автонапоминания
          </SectionTitle>
          {reminders.length === 0 ? (
            <p className="text-slate-500 text-sm">Напоминаний пока нет. Создайте бронь на ближайшие часы.</p>
          ) : (
            <div className="space-y-3">
              {reminders.map((r, idx) => (
                <div key={idx} className="bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm rounded-2xl p-4">
                  {r.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
