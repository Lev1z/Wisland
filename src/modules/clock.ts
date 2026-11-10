import { homeDate, timeText } from "../dom";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function updateClock(): void {
  if (document.hidden) return;
  const now = new Date();
  timeText.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const weekday = ["Sun.", "Mon.", "Tue.", "Wed.", "Thu.", "Fri.", "Sat."][now.getDay()];
  homeDate.textContent = `${String(now.getFullYear()).slice(-2)}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${weekday}`;
}

export function initClock(): void {
  updateClock();
  document.addEventListener("visibilitychange", updateClock);
  window.setInterval(updateClock, 1000);
}
