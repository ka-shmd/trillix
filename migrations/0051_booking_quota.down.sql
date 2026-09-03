-- Откат 0051: ключ уходит из лимитов всех планов.
UPDATE plans SET limits = limits - 'booking_schedules_max';
