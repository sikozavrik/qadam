import React, { useState, useEffect } from 'react';
import { Dumbbell, Snowflake, LogOut, Plus, QrCode, CreditCard, X, ShieldAlert, Users, TrendingUp, Calendar, MapPin, CheckCircle2, AlertCircle, Trophy, Flame, Footprints, ScanLine } from 'lucide-react';

const API_URL = 'http://127.0.0.1:8000';

const STATUS_LABELS = { confirmed: 'Подтверждена', visited: 'Посещена ✅', cancelled: 'Отменена' };
const LEVEL_STEPS = [0, 5, 15, 30, 60];

const levelProgress = (s) => {
  if (s.next_level_at == null) return 100;
  const lower = [...LEVEL_STEPS].reverse().find((x) => x <= s.steps) ?? 0;
  return Math.round(((s.steps - lower) / (s.next_level_at - lower)) * 100);
};

// Проверка номера карты по алгоритму Луна
const luhnValid = (num) => {
  if (!/^\d{13,19}$/.test(num)) return false;
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

// Срок карты ММ/ГГ не должен быть в прошлом
const expiryValid = (v) => {
  const m = /^(\d{2})\/(\d{2})$/.exec(v);
  if (!m) return false;
  const mon = Number(m[1]);
  const yr = 2000 + Number(m[2]);
  if (mon < 1 || mon > 12) return false;
  return new Date(yr, mon, 1) > new Date();
};

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('studios');
  const [studios, setStudios] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [allUsers, setAllUsers] = useState([]); // Для админки

  // Qadam Streak, лидерборд, статистика админа, чекин
  const [stats, setStats] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [adminStats, setAdminStats] = useState(null);
  const [checkinCode, setCheckinCode] = useState('');

  // Toast-уведомления вместо alert
  const [toast, setToast] = useState(null);
  const notify = (msg, type) => {
    const t = type || (/успешн|активирован|добавлена|опубликована|подтвержд/i.test(msg) ? 'success' : 'error');
    setToast({ msg, type: t });
    setTimeout(() => setToast(null), 3500);
  };

  const loginUser = (u) => {
    localStorage.setItem('qadam_user_id', String(u.id));
    setUser(u);
  };
  const logout = () => {
    localStorage.removeItem('qadam_user_id');
    setUser(null);
    setStats(null);
    setTab('studios');
  };

  // Формы входа/регистрации
  const [isLoginView, setIsLoginView] = useState(true);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');

  // Фильтрация студий
  const [selectedCategory, setSelectedCategory] = useState('All');

  // Модальное окно оплаты картой
  const [showCardModal, setShowCardModal] = useState(false);
  const [selectedMonths, setSelectedMonths] = useState(1);
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');

  // Формы для админки
  const [newStudio, setNewStudio] = useState({ name: '', category: 'Gym', address: '', description: '' });
  const [newWorkout, setNewWorkout] = useState({ studio_id: '', title: '', trainer_name: '', start_time: '', max_spots: 15 });

  useEffect(() => {
    fetchStudios();
    fetchWorkouts();

    // Восстанавливаем сессию после обновления страницы
    const savedId = localStorage.getItem('qadam_user_id');
    if (savedId) {
      fetch(`${API_URL}/users/${savedId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((u) => { if (u) setUser(u); })
        .catch(() => {});
    }

    // Места в расписании обновляются сами каждые 15 секунд
    const timer = setInterval(fetchWorkouts, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (user) {
      fetchBookings();
      fetchStats();
      if (user.role === 'admin') {
        fetchAllUsers();
        fetchAdminStats();
      }
    }
  }, [user]);

  useEffect(() => {
    if (user && tab === 'progress') {
      fetchStats();
      fetchLeaderboard();
    }
  }, [tab]);

  const fetchStudios = async () => {
    try {
      const res = await fetch(`${API_URL}/studios`);
      setStudios(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchWorkouts = async () => {
    try {
      const res = await fetch(`${API_URL}/workouts`);
      setWorkouts(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchBookings = async () => {
    try {
      const res = await fetch(`${API_URL}/users/${user.id}/bookings`);
      setBookings(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_URL}/users/${user.id}/stats`);
      if (res.ok) setStats(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchLeaderboard = async () => {
    try {
      const res = await fetch(`${API_URL}/leaderboard`);
      if (res.ok) setLeaderboard(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchAdminStats = async () => {
    try {
      const res = await fetch(`${API_URL}/admin/stats`);
      if (res.ok) setAdminStats(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchAllUsers = async () => {
    // Эмуляция или запрос списка пользователей для админа
    try {
      const res = await fetch(`${API_URL}/users`); // если бэкенд поддерживает, иначе массив
      if (res.ok) setAllUsers(await res.json());
    } catch (e) { 
      // Запасной мок, если эндпоинта нет на бэкенде
      setAllUsers([
        { id: user.id, full_name: user.full_name, phone: user.phone, role: user.role, subscription_active: user.subscription_active }
      ]);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      });
      if (!res.ok) throw new Error('Неверный телефон или пароль');
      loginUser(await res.json());
    } catch (err) { notify(err.message); }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName, phone, password, role: 'user' })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Ошибка регистрации');
      }
      loginUser(await res.json());
    } catch (err) { notify(err.message); }
  };

  const openCardModal = (months) => {
    setSelectedMonths(months);
    setShowCardModal(true);
  };

  const handleCardPayment = async (e) => {
    e.preventDefault();
    if (!luhnValid(cardNumber.replace(/\s/g, ''))) { notify('Неверный номер карты', 'error'); return; }
    if (!expiryValid(cardExpiry)) { notify('Неверный или истёкший срок действия карты', 'error'); return; }
    if (!/^\d{3,4}$/.test(cardCvv)) { notify('Неверный CVV', 'error'); return; }

    try {
      const res = await fetch(`${API_URL}/users/${user.id}/subscribe?months=${selectedMonths}`, { method: 'POST' });
      if (!res.ok) throw new Error('Ошибка оплаты');
      setUser(await res.json());
      setShowCardModal(false);
      setCardNumber('');
      setCardExpiry('');
      setCardCvv('');
      notify('Оплата прошла успешно! Абонемент Qadam активирован 🎉');
    } catch (e) { 
      notify('Ошибка при обработке платежа'); 
    }
  };

const toggleFreeze = async () => {
    try {
      const res = await fetch(`${API_URL}/users/${user.id}/freeze`, { method: 'POST' });
      
      // Если сервер вернул ошибку, не даем приложению упасть
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Ошибка при изменении статуса заморозки');
      }

      const updatedUser = await res.json();
      
      // Аккуратно обновляем только нужные поля, сохраняя остальные данные пользователя в безопасности
      setUser(prev => ({
        ...prev,
        is_frozen: updatedUser.is_frozen !== undefined ? updatedUser.is_frozen : !prev.is_frozen,
        subscription_active: updatedUser.subscription_active !== undefined ? updatedUser.subscription_active : prev.subscription_active
      }));
    } catch (e) { 
      console.error("Freeze error:", e);
      notify(e.message || 'Не удалось обновить статус абонемента'); 
    }
  };

  const bookWorkout = async (workoutId) => {
    if (!user.subscription_active) {
      notify('Для записи на тренировку необходим активный абонемент Qadam!');
      setTab('profile');
      return;
    }
    try {
      const res = await fetch(`${API_URL}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id, workout_id: workoutId })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Ошибка бронирования');
      }
      notify('Тренировка успешно забронирована!');
      fetchWorkouts();
      fetchBookings();
    } catch (err) { notify(err.message); }
  };

  const cancelBooking = async (bookingId) => {
    try {
      await fetch(`${API_URL}/bookings/${bookingId}/cancel`, { method: 'POST' });
      fetchWorkouts();
      fetchBookings();
    } catch (e) { notify('Ошибка отмены'); }
  };

  const handleCheckin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/bookings/${encodeURIComponent(checkinCode.trim())}/checkin`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'Ошибка чекина');
      notify(`${data.user_name}: «${data.workout_title}» — чекин подтверждён! +1 шаг`, 'success');
      setCheckinCode('');
      fetchAdminStats();
    } catch (err) { notify(err.message, 'error'); }
  };

  const handleCreateStudio = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/studios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newStudio)
      });
      if (res.ok) {
        notify('Студия успешно добавлена в сеть!');
        setNewStudio({ name: '', category: 'Gym', address: '', description: '' });
        fetchStudios();
      }
    } catch (e) { notify('Ошибка создания студии'); }
  };

  const handleCreateWorkout = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/workouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newWorkout,
          studio_id: Number(newWorkout.studio_id),
          max_spots: Number(newWorkout.max_spots)
        })
      });
      if (res.ok) {
        notify('Тренировка опубликована в расписание!');
        setNewWorkout({ studio_id: '', title: '', trainer_name: '', start_time: '', max_spots: 15 });
        fetchWorkouts();
      }
    } catch (e) { notify('Ошибка создания тренировки'); }
  };

  const toastEl = toast && (
    <div className={`fixed top-6 right-6 z-[100] max-w-sm px-5 py-4 rounded-2xl border shadow-2xl backdrop-blur-xl font-semibold text-sm flex items-start gap-3 ${toast.type === 'success' ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
      {toast.type === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertCircle className="w-5 h-5 shrink-0" />}
      <span>{toast.msg}</span>
    </div>
  );

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 flex items-center justify-center p-4 relative overflow-hidden">
        {toastEl}
        {/* Декоративные крутые круги фонового свечения */}
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl pointer-events-none"></div>

        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800/80 p-8 rounded-3xl w-full max-w-md shadow-2xl relative z-10">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="bg-emerald-500/10 border border-emerald-500/30 p-3 rounded-2xl">
              <Dumbbell className="w-8 h-8 text-emerald-400" />
            </div>
            <h1 className="text-3xl font-black text-white tracking-wider">QADAM</h1>
          </div>
          <p className="text-slate-400 text-center text-sm mb-8">Премиальный мульти-абонемент в лучшие фитнес-студии</p>

          <div className="flex bg-slate-950/80 p-1.5 rounded-2xl mb-6 border border-slate-800">
            <button
              type="button"
              onClick={() => setIsLoginView(true)}
              className={`flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all duration-300 ${isLoginView ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-white'}`}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => setIsLoginView(false)}
              className={`flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all duration-300 ${!isLoginView ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-white'}`}
            >
              Регистрация
            </button>
          </div>

          <form onSubmit={isLoginView ? handleLogin : handleRegister} className="space-y-4">
            {!isLoginView && (
              <div>
                <label className="text-xs text-slate-400 uppercase font-bold tracking-wider">Ваше имя</label>
                <input
                  type="text"
                  placeholder="Сабырхан Серік"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
                />
              </div>
            )}
            <div>
              <label className="text-xs text-slate-400 uppercase font-bold tracking-wider">Номер телефона</label>
              <input
                type="text"
                placeholder="+7 701 000 0000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 uppercase font-bold tracking-wider">Пароль</label>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
              />
            </div>
            <button type="submit" className="w-full bg-emerald-500 text-slate-950 font-bold py-4 rounded-2xl hover:bg-emerald-400 transition-all shadow-xl shadow-emerald-500/20 mt-2">
              {isLoginView ? 'Войти в систему' : 'Создать аккаунт'}
            </button>
          </form>

          {isLoginView && (
            <div className="mt-6 p-4 bg-slate-950/60 border border-slate-800/80 rounded-2xl text-xs text-slate-400 flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
              <div>
                <span className="text-purple-400 font-bold">Корпоративный вход:</span><br />
                Для доступа к панели управления используйте логин администратора: <code className="text-slate-200 bg-slate-900 px-1.5 py-0.5 rounded font-mono">+77770000000</code>.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const filteredStudios = selectedCategory === 'All' 
    ? studios 
    : studios.filter(s => s.category.toLowerCase() === selectedCategory.toLowerCase());

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-emerald-500 selection:text-slate-950">
      {toastEl}
      {/* Навигационная панель */}
      <header className="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur-xl sticky top-0 z-50 px-6 py-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500/10 border border-emerald-500/30 p-2 rounded-xl">
            <Dumbbell className="w-6 h-6 text-emerald-400" />
          </div>
          <span className="text-xl font-black tracking-wider bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">QADAM</span>
        </div>

        <nav className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800 p-1.5 rounded-2xl">
          <button onClick={() => setTab('studios')} className={`px-4 py-2 rounded-xl font-semibold text-sm transition-all ${tab === 'studios' ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-white'}`}>Студии</button>
          <button onClick={() => setTab('workouts')} className={`px-4 py-2 rounded-xl font-semibold text-sm transition-all ${tab === 'workouts' ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-white'}`}>Расписание</button>
          <button onClick={() => setTab('profile')} className={`px-4 py-2 rounded-xl font-semibold text-sm transition-all ${tab === 'profile' ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-white'}`}>Абонемент</button>
          <button onClick={() => setTab('progress')} className={`px-4 py-2 rounded-xl font-semibold text-sm transition-all ${tab === 'progress' ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-white'}`}>Прогресс</button>
          {user.role === 'admin' && (
            <button onClick={() => setTab('admin')} className={`px-4 py-2 rounded-xl font-semibold text-sm transition-all ${tab === 'admin' ? 'bg-purple-500 text-slate-950 shadow-md shadow-purple-500/20' : 'text-purple-400 hover:bg-purple-500/10'}`}>👑 Панель админа</button>
          )}
        </nav>

        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <div className="font-bold text-sm">{user.full_name}</div>
            <div className="text-xs font-medium text-emerald-400 flex items-center justify-end gap-1">
              {user.role === 'admin' ? (
                <span className="text-purple-400">🛡️ Администратор</span>
              ) : (
                user.subscription_active ? (user.is_frozen ? '❄️ Заморожен' : '✅ Активный абонемент') : '❌ Нет подписки'
              )}
            </div>
          </div>
          <button onClick={logout} className="p-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition" title="Выйти">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Основной контент */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8">
        {tab === 'studios' && (
          <div>
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
              <div>
                <h2 className="text-3xl font-black tracking-tight">Партнерские студии</h2>
                <p className="text-slate-400 text-sm mt-1">Выбирайте лучшие фитнес-пространства города по одному абонементу</p>
              </div>
              {/* Фильтры категорий */}
              <div className="flex flex-wrap gap-2 bg-slate-900 p-1.5 rounded-2xl border border-slate-800">
                {['All', 'Gym', 'Yoga', 'CrossFit', 'Swimming'].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition ${selectedCategory === cat ? 'bg-slate-800 text-emerald-400 border border-slate-700' : 'text-slate-400 hover:text-white'}`}
                  >
                    {cat === 'All' ? 'Все студии' : cat}
                  </button>
                ))}
              </div>
            </div>

            {filteredStudios.length === 0 ? (
              <div className="bg-slate-900/50 border border-slate-800/80 rounded-3xl p-12 text-center text-slate-400 backdrop-blur">
                <MapPin className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <p className="text-lg font-semibold text-white">Студии не найдены</p>
                <p className="text-sm mt-1">В этой категории пока нет добавленных точек.</p>
                {user.role === 'admin' && (
                  <button onClick={() => setTab('admin')} className="mt-4 px-6 py-2.5 bg-purple-500/10 border border-purple-500/30 text-purple-400 rounded-xl font-bold text-sm hover:bg-purple-500/20 transition">
                    Добавить первую студию в админке
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {filteredStudios.map((s) => (
                  <div key={s.id} className="bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 hover:border-emerald-500/40 rounded-3xl p-6 flex flex-col justify-between transition-all duration-300 group shadow-xl">
                    <div>
                      <div className="flex justify-between items-center mb-4">
                        <span className="text-xs font-black uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded-full">{s.category}</span>
                        <span className="text-xs text-slate-500 font-mono">ID #{s.id}</span>
                      </div>
                      <h3 className="text-xl font-extrabold group-hover:text-emerald-400 transition">{s.name}</h3>
                      <p className="text-slate-400 text-xs mt-1.5 flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-emerald-400" /> {s.address}</p>
                      <p className="text-slate-300 text-sm mt-4 leading-relaxed">{s.description}</p>
                    </div>
                    <button onClick={() => setTab('workouts')} className="mt-8 w-full bg-slate-800/80 hover:bg-emerald-500 hover:text-slate-950 py-3 rounded-2xl text-sm font-bold transition-all shadow-md">
                      Расписание тренировок
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'workouts' && (
          <div>
            <div className="mb-8">
              <h2 className="text-3xl font-black tracking-tight">Расписание занятий</h2>
              <p className="text-slate-400 text-sm mt-1">Бронируйте места на групповые и персональные тренировки</p>
            </div>

            {workouts.length === 0 ? (
              <div className="bg-slate-900/50 border border-slate-800/80 rounded-3xl p-12 text-center text-slate-400 backdrop-blur">
                <Calendar className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <p className="text-lg font-semibold text-white">Расписание пока пусто</p>
                <p className="text-sm mt-1">Администратор еще не добавил активные тренировки.</p>
                {user.role === 'admin' && (
                  <button onClick={() => setTab('admin')} className="mt-4 px-6 py-2.5 bg-purple-500/10 border border-purple-500/30 text-purple-400 rounded-xl font-bold text-sm hover:bg-purple-500/20 transition">
                    Создать тренировку
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {workouts.map((w) => {
                  const studio = studios.find((s) => s.id === w.studio_id);
                  const isFull = w.booked_spots >= w.max_spots;
                  return (
                    <div key={w.id} className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-6 flex flex-col justify-between shadow-xl">
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-3 py-1 rounded-full">
                            {studio ? studio.name : `Студия #${w.studio_id}`}
                          </span>
                          <span className="text-xs text-slate-400 font-medium">Тренер: <strong className="text-white">{w.trainer_name}</strong></span>
                        </div>
                        <h3 className="text-xl font-bold mt-2">{w.title}</h3>
                        <div className="text-sm text-slate-400 mt-2 flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-emerald-400" /> {new Date(w.start_time).toLocaleString()}
                        </div>
                        <div className="mt-4 flex items-center justify-between text-xs text-slate-400 bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                          <span>Занято мест: <strong className="text-white">{w.booked_spots} / {w.max_spots}</strong></span>
                          <div className="w-24 bg-slate-800 h-2 rounded-full overflow-hidden">
                            <div className="bg-emerald-400 h-full transition-all" style={{ width: `${(w.booked_spots / w.max_spots) * 100}%` }}></div>
                          </div>
                        </div>
                      </div>
                      <button 
                        onClick={() => bookWorkout(w.id)} 
                        disabled={isFull}
                        className={`mt-6 w-full py-3.5 rounded-2xl font-bold text-sm transition-all ${isFull ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20'}`}
                      >
                        {isFull ? 'Мест нет' : 'Забронировать место'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'profile' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Управление абонементом */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-8 shadow-xl flex flex-col justify-between">
              <div>
                <h3 className="text-2xl font-black mb-6">Ваш абонемент Qadam</h3>
                <div className="bg-slate-950/80 p-6 rounded-2xl border border-slate-800/80 mb-6 space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400 text-sm">Статус подписки:</span>
                    <span className={`font-bold px-3 py-1 rounded-full text-xs ${user.subscription_active ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/10 text-red-400 border border-red-500/30'}`}>
                      {user.subscription_active ? 'Активен' : 'Не активен'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400 text-sm">Действует до:</span>
                    <span className="text-white font-bold font-mono">{user.subscription_until ? new Date(user.subscription_until).toLocaleDateString() : '—'}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400 text-sm">Режим заморозки:</span>
                    <span className="text-white font-bold">{user.is_frozen ? '❄️ Заморожен' : '☀️ Активен'}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="text-xs text-slate-400 uppercase font-bold tracking-wider">Продлить или активировать</p>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => openCardModal(1)} className="bg-emerald-500 text-slate-950 font-bold py-3.5 rounded-2xl hover:bg-emerald-400 transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20">
                      <CreditCard className="w-4 h-4" /> 1 месяц
                    </button>
                    <button onClick={() => openCardModal(3)} className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-3.5 rounded-2xl transition flex items-center justify-center gap-2 border border-slate-700">
                      <CreditCard className="w-4 h-4 text-emerald-400" /> 3 месяца
                    </button>
                  </div>
                </div>
              </div>

              <button onClick={toggleFreeze} className="mt-6 w-full bg-slate-950 hover:bg-slate-900 border border-slate-800 py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 text-slate-300 transition">
                <Snowflake className="w-5 h-5 text-cyan-400" /> {user.is_frozen ? 'Разморозить абонемент' : 'Заморозить абонемент'}
              </button>
            </div>

            {/* Бронирования и QR */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-8 shadow-xl">
              <h3 className="text-2xl font-black mb-6">Мои бронирования и QR-коды</h3>
              <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2">
                {bookings.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <QrCode className="w-12 h-12 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">У вас пока нет активных записей на тренировки.</p>
                  </div>
                ) : (
                  bookings.map((b) => (
                    <div key={b.id} className="bg-slate-950/80 p-5 rounded-2xl border border-slate-800 flex justify-between items-center">
                      <div className="flex items-center gap-4">
                        <div className="bg-emerald-500/10 p-3 rounded-2xl border border-emerald-500/20">
                          <QrCode className="w-7 h-7 text-emerald-400" />
                        </div>
                        <div>
                          {b.workout_title && <div className="font-bold text-white">{b.workout_title}</div>}
                          {b.start_time && <div className="text-xs text-slate-400">{b.studio_name ? b.studio_name + ' · ' : ''}{new Date(b.start_time).toLocaleString()}</div>}
                          <div className="font-mono font-bold text-emerald-400 text-lg tracking-wider mt-1">{b.qr_code}</div>
                          <div className="text-xs text-slate-400 mt-0.5">Статус: <span className="text-white font-semibold">{STATUS_LABELS[b.status] || b.status}</span></div>
                        </div>
                      </div>
                      {b.status === 'confirmed' && (
                        <button onClick={() => cancelBooking(b.id)} className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 px-4 py-2 rounded-xl text-xs font-bold transition">
                          Отменить
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Qadam Streak: прогресс пользователя */}
        {tab === 'progress' && (
          <div className="space-y-8">
            <div>
              <h2 className="text-3xl font-black tracking-tight">Мой прогресс</h2>
              <p className="text-slate-400 text-sm mt-1">Каждое подтверждённое посещение — один шаг (қадам). Занимайтесь каждую неделю, чтобы не прервать серию.</p>
            </div>

            {!stats ? (
              <div className="text-slate-400">Загрузка...</div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex items-center gap-4">
                    <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-2xl text-emerald-400"><Footprints className="w-8 h-8" /></div>
                    <div>
                      <div className="text-slate-400 text-xs font-bold uppercase">Шагов</div>
                      <div className="text-3xl font-black mt-1">{stats.steps}</div>
                    </div>
                  </div>
                  <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex items-center gap-4">
                    <div className="bg-orange-500/10 border border-orange-500/30 p-4 rounded-2xl text-orange-400"><Flame className="w-8 h-8" /></div>
                    <div>
                      <div className="text-slate-400 text-xs font-bold uppercase">Серия недель</div>
                      <div className="text-3xl font-black mt-1">{stats.current_streak}</div>
                    </div>
                  </div>
                  <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex items-center gap-4">
                    <div className="bg-purple-500/10 border border-purple-500/30 p-4 rounded-2xl text-purple-400"><Trophy className="w-8 h-8" /></div>
                    <div>
                      <div className="text-slate-400 text-xs font-bold uppercase">Лучшая серия</div>
                      <div className="text-3xl font-black mt-1">{stats.best_streak}</div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8">
                  <div className="flex justify-between items-end mb-3">
                    <div>
                      <div className="text-slate-400 text-xs font-bold uppercase">Ваш уровень</div>
                      <div className="text-2xl font-black text-emerald-400">{stats.level}</div>
                    </div>
                    <div className="text-xs text-slate-400">
                      {stats.next_level_at != null ? `${stats.steps} / ${stats.next_level_at} шагов до следующего уровня` : 'Максимальный уровень достигнут 🎉'}
                    </div>
                  </div>
                  <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-emerald-500 to-cyan-400 h-full transition-all duration-700" style={{ width: `${levelProgress(stats)}%` }}></div>
                  </div>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8">
                  <h3 className="text-xl font-black mb-4">Бейджи</h3>
                  {stats.badges.length === 0 ? (
                    <p className="text-slate-500 text-sm">Пока нет бейджей. Сходите на первую тренировку и пройдите чекин!</p>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      {stats.badges.map((b) => (
                        <div key={b.id} className="bg-slate-950/80 border border-slate-800 px-4 py-3 rounded-2xl flex items-center gap-2 text-sm font-bold">
                          <span className="text-xl">{b.emoji}</span> {b.title}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8">
              <h3 className="text-xl font-black mb-4 flex items-center gap-2"><Trophy className="w-5 h-5 text-purple-400" /> Топ-10 по шагам</h3>
              {leaderboard.length === 0 ? (
                <p className="text-slate-500 text-sm">Рейтинг появится после первых подтверждённых посещений.</p>
              ) : (
                <div className="space-y-2">
                  {leaderboard.map((r, i) => (
                    <div key={r.user_id} className={`flex items-center justify-between px-4 py-3 rounded-2xl border ${r.user_id === user.id ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-950/60 border-slate-800'}`}>
                      <div className="flex items-center gap-3">
                        <span className="w-6 text-center font-black text-slate-400">{i + 1}</span>
                        <span className="font-semibold">{r.full_name}</span>
                      </div>
                      <span className="font-mono font-bold text-emerald-400">{r.steps}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Профессиональная Админ-панель */}
        {tab === 'admin' && user.role === 'admin' && (
          <div className="space-y-8">
            {/* Статистика / Дашборд */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex items-center gap-4">
                <div className="bg-purple-500/10 border border-purple-500/30 p-4 rounded-2xl text-purple-400">
                  <Users className="w-8 h-8" />
                </div>
                <div>
                  <div className="text-slate-400 text-xs font-bold uppercase">Партнерские студии</div>
                  <div className="text-3xl font-black mt-1">{studios.length}</div>
                </div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex items-center gap-4">
                <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-2xl text-emerald-400">
                  <TrendingUp className="w-8 h-8" />
                </div>
                <div>
                  <div className="text-slate-400 text-xs font-bold uppercase">Активные тренировки</div>
                  <div className="text-3xl font-black mt-1">{workouts.length}</div>
                </div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex items-center gap-4">
                <div className="bg-blue-500/10 border border-blue-500/30 p-4 rounded-2xl text-blue-400">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <div>
                  <div className="text-slate-400 text-xs font-bold uppercase">Всего бронирований</div>
                  <div className="text-3xl font-black mt-1">{adminStats ? adminStats.bookings : 0}</div>
                </div>
              </div>
            </div>

            {/* Чекин по QR-коду */}
            <form onSubmit={handleCheckin} className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8 shadow-xl flex flex-col md:flex-row gap-4 md:items-end">
              <div className="flex-1">
                <h3 className="text-xl font-black text-purple-400 flex items-center gap-2 mb-3"><ScanLine className="w-6 h-6" /> Чекин по QR-коду</h3>
                <input
                  type="text"
                  placeholder="QADAM-XXXXXXXX"
                  value={checkinCode}
                  onChange={(e) => setCheckinCode(e.target.value.toUpperCase())}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white font-mono tracking-widest focus:outline-none focus:border-purple-500"
                />
              </div>
              <button type="submit" className="bg-purple-500 hover:bg-purple-400 text-slate-950 font-bold px-8 py-3.5 rounded-2xl transition shadow-lg shadow-purple-500/20">Подтвердить посещение</button>
            </form>

            {/* Формы добавления контента */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <form onSubmit={handleCreateStudio} className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8 space-y-4 shadow-xl">
                <h3 className="text-xl font-black text-purple-400 flex items-center gap-2"><Plus className="w-6 h-6" /> Добавить новую студию</h3>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Название студии</label>
                  <input type="text" placeholder="FitNation Premium" value={newStudio.name} onChange={(e) => setNewStudio({ ...newStudio, name: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Категория</label>
                  <select value={newStudio.category} onChange={(e) => setNewStudio({ ...newStudio, category: e.target.value })} className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500">
                    <option value="Gym">Gym (Тренажерный зал)</option>
                    <option value="Yoga">Yoga (Йога)</option>
                    <option value="CrossFit">CrossFit (Кроссфит)</option>
                    <option value="Swimming">Swimming (Бассейн)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Адрес</label>
                  <input type="text" placeholder="ул. Достык, 120" value={newStudio.address} onChange={(e) => setNewStudio({ ...newStudio, address: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Описание</label>
                  <textarea placeholder="Современное оборудование, премиальный сервис..." value={newStudio.description} onChange={(e) => setNewStudio({ ...newStudio, description: e.target.value })} className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500 h-24" />
                </div>
                <button type="submit" className="w-full bg-purple-500 hover:bg-purple-400 text-slate-950 font-bold py-3.5 rounded-2xl transition shadow-lg shadow-purple-500/20">Сохранить студию</button>
              </form>

              <form onSubmit={handleCreateWorkout} className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8 space-y-4 shadow-xl">
                <h3 className="text-xl font-black text-purple-400 flex items-center gap-2"><Plus className="w-6 h-6" /> Создать тренировку</h3>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Студия</label>
                  <select value={newWorkout.studio_id} onChange={(e) => setNewWorkout({ ...newWorkout, studio_id: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500">
                    <option value="">Выберите студию из списка...</option>
                    {studios.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.category})</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Название тренировки</label>
                  <input type="text" placeholder="Functional Training" value={newWorkout.title} onChange={(e) => setNewWorkout({ ...newWorkout, title: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold">Имя тренера</label>
                  <input type="text" placeholder="Алексей Смирнов" value={newWorkout.trainer_name} onChange={(e) => setNewWorkout({ ...newWorkout, trainer_name: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-400 uppercase font-bold">Дата и время</label>
                    <input type="datetime-local" value={newWorkout.start_time} onChange={(e) => setNewWorkout({ ...newWorkout, start_time: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 uppercase font-bold">Макс. мест</label>
                    <input type="number" placeholder="15" value={newWorkout.max_spots} onChange={(e) => setNewWorkout({ ...newWorkout, max_spots: e.target.value })} required className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-purple-500" />
                  </div>
                </div>
                <button type="submit" className="w-full bg-purple-500 hover:bg-purple-400 text-slate-950 font-bold py-3.5 rounded-2xl transition shadow-lg shadow-purple-500/20 mt-2">Опубликовать в расписание</button>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* Профессиональное модальное окно оплаты */}
      {showCardModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-8 relative shadow-2xl">
            <button onClick={() => setShowCardModal(false)} className="absolute top-6 right-6 text-slate-400 hover:text-white transition">
              <X className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-emerald-500/10 border border-emerald-500/30 p-3 rounded-2xl text-emerald-400">
                <CreditCard className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-xl font-black">Оплата абонемента</h3>
                <p className="text-xs text-slate-400">Продление на {selectedMonths} {selectedMonths === 1 ? 'месяц' : 'месяца'}</p>
              </div>
            </div>

            <form onSubmit={handleCardPayment} className="space-y-4 mt-6">
              <div>
                <label className="text-xs text-slate-400 uppercase font-bold tracking-wider">Номер банковской карты</label>
                <input
                  type="text"
                  placeholder="4400 4300 0000 0000"
                  maxLength="19"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim())}
                  required
                  className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-white focus:outline-none focus:border-emerald-500 font-mono tracking-widest text-center"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold tracking-wider">Срок (ММ/ГГ)</label>
                  <input
                    type="text"
                    placeholder="12/28"
                    maxLength="5"
                    value={cardExpiry}
                    onChange={(e) => { let v = e.target.value.replace(/\D/g, '').slice(0, 4); if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2); setCardExpiry(v); }}
                    required
                    className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-white focus:outline-none focus:border-emerald-500 text-center font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase font-bold tracking-wider">CVV / CVC</label>
                  <input
                    type="password"
                    placeholder="123"
                    maxLength="4"
                    value={cardCvv}
                    onChange={(e) => setCardCvv(e.target.value)}
                    required
                    className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-white focus:outline-none focus:border-emerald-500 text-center font-mono"
                  />
                </div>
              </div>
              <button type="submit" className="w-full bg-emerald-500 text-slate-950 font-bold py-4 rounded-2xl hover:bg-emerald-400 transition shadow-xl shadow-emerald-500/20 mt-4">
                Оплатить подписку
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}