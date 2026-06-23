# Free-tier Deployment Runbook

สถาปัตยกรรมรอบทดลอง:

```text
Browser → Vercel (Next.js + HTTPS)
                  ↓ same-origin rewrite
          Render (Spring Boot API + HTTPS)
                  ↓ TLS
             Neon PostgreSQL
```

## ข้อจำกัดที่ต้องทราบ

- Vercel Hobby ใช้กับงานส่วนตัว/non-commercial เท่านั้น
- Render Free จะ sleep หลังไม่มี request 15 นาที การเปิดครั้งแรกอาจรอประมาณ 1 นาที
- Neon Free มี storage 0.5 GB, compute 100 CU-hours/project/month และ scale-to-zero
- Free tier ไม่มี SLA และไม่ควรเป็นปลายทางของการแข่งขันที่รับความเสี่ยง downtime ไม่ได้
- ก่อนวันแข่งจริงควร export backup และพิจารณาอัปเกรด backend อย่างน้อยชั่วคราวเพื่อไม่ให้ cold start

## 1. เตรียม GitHub

1. สร้าง private repository
2. Push branch `main`
3. ตรวจว่า GitHub Actions งาน `CI` ผ่านทั้ง frontend และ backend
4. ห้าม commit `.env`, database URL, password, BCrypt hash หรือ session data

## 2. สร้าง Neon PostgreSQL

1. สมัคร Neon และสร้าง project เช่น `ctwe-tournament`
2. เลือก region ใกล้ Render มากที่สุด
3. ใช้ branch `main` และ database เริ่มต้น
4. เปิด **Connect** และเลือก direct connection สำหรับ backend ตัวเดียว
5. แยกค่าจาก connection string:

```text
postgresql://ROLE:PASSWORD@HOST/DATABASE?sslmode=require
```

เป็น Render secrets:

```text
DATABASE_URL=jdbc:postgresql://HOST/DATABASE?sslmode=require
DATABASE_USER=ROLE
DATABASE_PASSWORD=PASSWORD
```

อย่าใส่ user/password ซ้ำใน `DATABASE_URL` และห้ามใช้ค่าจริงใน Git

## 3. สร้างบัญชีเจ้าหน้าที่เริ่มต้น

สร้าง password ที่สุ่มและยาวอย่างน้อย 16 ตัว จากนั้นสร้าง BCrypt cost 12 บนเครื่อง local:

```bash
htpasswd -bnBC 12 "" 'YOUR_STRONG_PASSWORD' | tr -d ':\n'
```

เก็บ password ใน password manager และนำเฉพาะ hash ไปใส่ Render:

```text
STAFF_USERNAME=ชื่อบัญชีที่ไม่เดาง่าย
STAFF_PASSWORD_HASH=$2y$12$...
```

ห้ามแชร์บัญชีเดียวกันระหว่างเจ้าหน้าที่ เพราะ audit log จะระบุผู้กระทำไม่ถูกต้อง

## 4. Deploy backend บน Render

1. Render Dashboard → **New +** → **Blueprint**
2. เชื่อม private GitHub repository
3. เลือก `render.yaml` จาก root
4. เลือก instance `Free`
5. กรอก secret ที่ Blueprint ขอ:

```text
DATABASE_URL
DATABASE_USER
DATABASE_PASSWORD
STAFF_USERNAME
STAFF_PASSWORD_HASH
```

ค่าที่ต้องคงไว้:

```text
SESSION_COOKIE_SECURE=true
DEV_TOOLS_ENABLED=false
DB_POOL_MAX_SIZE=5
DB_POOL_MIN_IDLE=0
```

เมื่อ deploy สำเร็จ ให้เปิด:

```text
https://YOUR-RENDER-SERVICE.onrender.com/actuator/health
```

ต้องได้ `{"status":"UP"}` Flyway จะสร้าง schema และ migrations อัตโนมัติเมื่อ backend เริ่มทำงาน

## 5. Deploy frontend บน Vercel

1. Vercel Dashboard → **Add New Project**
2. Import GitHub repository เดียวกัน
3. Framework preset: `Next.js`
4. Root directory: repository root
5. เพิ่ม Environment Variable สำหรับ Production และ Preview:

```text
BACKEND_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

6. Deploy และใช้ URL `https://YOUR-PROJECT.vercel.app`

Frontend proxy `/api`, `/login`, `/logout` ไป backend ทำให้ browser ใช้ session cookie แบบ same-origin และไม่ต้องเปิด CORS

## 6. Production smoke test

ทดสอบตามลำดับ:

1. Public เปิด `/cards` ได้โดยไม่ login
2. Public เข้า `/cards/{id}/players`, `/tables`, `/games`, `/audit` ไม่ได้
3. Staff login ได้และ cookie มี `Secure`, `HttpOnly`, `SameSite=Strict`
4. สร้าง test card → เพิ่มผู้เล่น → Finish registration
5. Pairing → กรอกผล → Review → Publish
6. Logout แล้วตรวจว่า public เห็นเฉพาะข้อมูลที่ Publish
7. `/dev-tools` ต้องไม่สามารถ mutation ใน production เพราะ `DEV_TOOLS_ENABLED=false`
8. ตรวจ Render logs ว่าไม่มี password, CSRF token หรือ session ID หลุดใน log

## 7. Backup และวันแข่งขันจริง

- Export card หลังจบแต่ละช่วงสำคัญ
- สร้าง Neon manual snapshot ก่อนเริ่มงานและก่อน migration สำคัญ
- ทดสอบ restore บน Neon branch แยก
- ตั้งผู้รับผิดชอบ monitor Render/Neon/Vercel dashboards
- Free Render cold start ไม่เหมาะกับช่วงเปิดรับผลแบบต่อเนื่อง หากเป็นงานจริงให้อัปเกรด backend ก่อนเริ่มงาน
