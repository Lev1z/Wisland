import { timeText } from "../dom";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function updateClock(): void {
  const now = new Date();
  timeText.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function initClock(): void {
  updateClock();
  window.setInterval(updateClock, 1000);
}
