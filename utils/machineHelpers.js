// ─── Status map matching React Native app ─────────────
const STATUS_MAP = {
  running:   'RUNNING',
  stopped:   'STOPPED',
  power_off: 'POWER OFF',
};

const normaliseStatus = (raw) => {
  if (!raw) return 'STOPPED';
  return STATUS_MAP[raw.toLowerCase()] || raw.toUpperCase();
};

// ─── Build machine identity key ───────────────────────
const buildMachineKey = (siteId, lineId, machineId) =>
  `${siteId}:${lineId}:${machineId}`;

// ─── Format runtime seconds into hh:mm:ss ────────────
const formatRuntime = (totalSeconds) => {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return {
    hours:   String(h).padStart(2, '0'),
    minutes: String(m).padStart(2, '0'),
    seconds: String(s).padStart(2, '0'),
    display: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
  };
};

module.exports = { normaliseStatus, buildMachineKey, formatRuntime };