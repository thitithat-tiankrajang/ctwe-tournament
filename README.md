# Tournament Control

คู่มือ deploy รอบทดลองแบบ Free tier: [`DEPLOYMENT_FREE_TIER.md`](DEPLOYMENT_FREE_TIER.md)

ระบบจัดการแข่งขัน Next.js + Spring Boot + PostgreSQL โดย PostgreSQL เป็น source of truth เพียงจุดเดียว ไม่มี mock/browser-persisted state ใน runtime จริง

## สิทธิ์การใช้งาน

- **Public viewer**: ดูการ์ด รายชื่อ อันดับ โต๊ะ และผลการแข่งขันได้โดยไม่ต้อง login
- **Staff member**: สร้าง/แก้ข้อมูล เปิดเกม บันทึกผล ปิดการ์ด ดู audit และใช้ dev tools เมื่อเปิด feature flag
- Backend บังคับ authorization ทุก mutation; การซ่อนปุ่มใน UI เป็นเพียงชั้น UX
- Staff password เก็บเป็น BCrypt cost 12+, session เป็น HttpOnly/SameSite cookie, CSRF เปิด, login ผิด 5 ครั้ง lock 15 นาที
- Confirmed pairing snapshots ถูกป้องกันการ update/delete ด้วย PostgreSQL trigger

## Tournament workflow

Backend บังคับลำดับงานด้วย `runtime_stage`:

1. `PLAYER_REGISTRATION` — เพิ่ม/ลบผู้เล่น รหัส `P0001...` สร้างอัตโนมัติ ชื่อซ้ำได้หลังเจ้าหน้าที่ยืนยัน warning
2. `TABLE_PAIRING` — พร้อมสร้าง pairing ของเกมปัจจุบัน
3. `PAIRING_PREVIEW` — ตรวจ pairing; เกม 1 สลับที่นั่งได้และมี school-conflict warning เกมถัดไปแก้ pairing เองไม่ได้
4. `RESULT_COLLECTION` — บันทึกผลทีละคู่ ผลเดิมต้องกด Edit ก่อนแก้เพื่อเก็บ audit history
5. `RESULT_REVIEW` — แสดงรายการผลทั้งหมดก่อน publish และย้อนกลับไปแก้ได้
6. Finish จะสร้าง immutable snapshot แล้วกลับไป `TABLE_PAIRING` ของเกมถัดไป; เกมสุดท้ายเป็น `FINAL_PUBLISHED`

Public UI เห็นเฉพาะ card menu และ overview ที่สร้างจาก snapshot ซึ่ง publish แล้วเท่านั้น

## ตั้งค่าครั้งแรก

ต้องมี Java 17+, Maven, Node.js และ Docker Desktop

1. สร้างไฟล์ environment:

   ```bash
   cp .env.example .env
   openssl rand -base64 36
   htpasswd -bnBC 12 "" 'รหัสผ่านเจ้าหน้าที่ที่แข็งแรง' | tr -d ':\n'
   ```

   นำผลลัพธ์แรกใส่ `DATABASE_PASSWORD` และผลลัพธ์ BCrypt ใส่ `STAFF_PASSWORD_HASH` ใน `.env` โดยครอบ hash ด้วย single quotes เพื่อรักษาอักขระ `$` ห้าม commit `.env`

2. เปิด PostgreSQL จริง:

   ```bash
   docker compose up -d --wait
   ```

3. เปิด backend (Terminal 1):

   ```bash
   cd backend
   set -a
   source ../.env
   set +a
   mvn spring-boot:run
   ```

4. เปิด frontend (Terminal 2):

   ```bash
   npm install
   npm run dev
   ```

5. เปิด `http://localhost:3000/cards` บุคคลทั่วไปดูได้ทันที เจ้าหน้าที่กด “เข้าสู่ระบบเจ้าหน้าที่”

> Local HTTP เท่านั้นให้ใช้ `SESSION_COOKIE_SECURE=false` ส่วน production ต้องเป็น `true` และให้บริการผ่าน HTTPS เท่านั้น

## สมาชิกเจ้าหน้าที่เพิ่มเติม

สร้าง BCrypt cost 12+ แยกต่อคน แล้วเพิ่มบัญชีผ่านช่องทางดูแลฐานข้อมูลที่จำกัดสิทธิ์:

```sql
BEGIN;
INSERT INTO staff_accounts (username, password_hash, enabled)
VALUES ('staff-name', '{bcrypt}$2y$12$...', true);
INSERT INTO staff_authorities (username, authority)
VALUES ('staff-name', 'ROLE_STAFF');
COMMIT;
```

ห้ามแชร์บัญชีร่วมกัน เพราะ audit log อ้างอิง username ของผู้ปฏิบัติงาน

## Production security checklist

- ใช้ managed PostgreSQL แบบ private network, TLS, encryption at rest และ automated backups
- แยก database migration owner ออกจาก runtime user และให้ runtime userเฉพาะสิทธิ์ที่จำเป็น
- เก็บ secrets ใน secret manager ไม่เก็บใน `.env` บน server
- ใช้ HTTPS/HSTS ที่ reverse proxy, ตั้ง `SESSION_COOKIE_SECURE=true`
- ตั้ง `DEV_TOOLS_ENABLED=false`
- สำหรับระบบองค์กร แนะนำเปลี่ยน local membership เป็น OIDC/SSO + MFA โดย map กลุ่มเจ้าหน้าที่เป็น `ROLE_STAFF`
- เก็บและ monitor audit/security logs โดยไม่ log password, session ID หรือ CSRF token

## Verification

```bash
npm run typecheck
npm run build
cd backend && mvn test
curl http://localhost:8080/actuator/health
```

API contract อยู่ที่ [`backend/API_CONTRACT.md`](backend/API_CONTRACT.md)
