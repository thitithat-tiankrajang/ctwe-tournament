/**
 * The message shown when `POST /login` fails. 429 comes from the backend's login throttle and
 * carries `Retry-After` in seconds — either a per-address lockout (minutes) or a brief "server busy
 * checking passwords" refusal (seconds).
 */
export function loginFailureMessage(status: number, retryAfter: string | null): string {
  if (status === 401) return "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง";
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return "เข้าสู่ระบบถี่เกินไป กรุณารอสักครู่แล้วลองใหม่";
    if (seconds < 60) return `ระบบกำลังตรวจสอบการเข้าสู่ระบบจำนวนมาก กรุณาลองใหม่ในอีก ${seconds} วินาที`;
    return `ใส่รหัสผ่านผิดหลายครั้ง กรุณารอประมาณ ${Math.ceil(seconds / 60)} นาทีแล้วลองใหม่`;
  }
  return `เข้าสู่ระบบไม่สำเร็จ (${status})`;
}
