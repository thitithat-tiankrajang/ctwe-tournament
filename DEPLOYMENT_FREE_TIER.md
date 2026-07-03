# Low-cost Deployment Runbook

สถาปัตยกรรมรอบทดลอง:

```text
Browser → Cloudflare Worker (Next.js + Static Assets + HTTPS)
                  ↓ same-origin streaming proxy
          Render (Spring Boot API + HTTPS)
                  ↓ TLS
             Neon PostgreSQL
```

## ข้อจำกัดที่ต้องทราบ

- Next.js แบบ full-stack deploy ด้วย Cloudflare Workers + OpenNext; ไม่ใช้ Pages static export
  เพราะโปรเจกต์มี dynamic routes, server route handlers และ SSE
- Static files ยังเสิร์ฟผ่าน Cloudflare Workers Static Assets ซึ่งทำหน้าที่ CDN แบบ Pages
- Render Blueprint ใช้ Starter 512 MB / 0.5 CPU เป็นค่าเริ่มต้น และไม่ควรลดเป็น Free ในวันใช้งานจริง
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

สร้าง VAPID key pair เพียงครั้งเดียวด้วย `npx web-push generate-vapid-keys` แล้วเก็บพร้อม
contact URI ของผู้ดูแลใน Render secrets (ห้ามเปลี่ยน key ตราบใดที่ยังใช้ subscription เดิม):

```text
VAPID_PUBLIC_KEY=กุญแจสาธารณะจาก web-push
VAPID_PRIVATE_KEY=กุญแจลับจาก web-push
VAPID_SUBJECT=mailto:อีเมลผู้ดูแลจริง
```

ห้ามแชร์บัญชีเดียวกันระหว่างเจ้าหน้าที่ เพราะ audit log จะระบุผู้กระทำไม่ถูกต้อง

## 4. Deploy backend บน Render

1. Render Dashboard → **New +** → **Blueprint**
2. เชื่อม private GitHub repository
3. เลือก `render.yaml` จาก root
4. เลือก instance `Starter`
5. กรอก secret ที่ Blueprint ขอ:

```text
DATABASE_URL
DATABASE_USER
DATABASE_PASSWORD
STAFF_USERNAME
STAFF_PASSWORD_HASH
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
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
https://YOUR-RENDER-SERVICE.onrender.com/actuator/health/readiness
```

ต้องได้ `{"status":"UP"}` Flyway จะสร้าง schema และ migrations อัตโนมัติเมื่อ backend เริ่มทำงาน

## 5. Deploy frontend บน Cloudflare Workers

โปรเจกต์เตรียม `wrangler.jsonc` และ OpenNext ไว้แล้ว ทดสอบ local build ก่อน:

```bash
npm ci
npm run typecheck
npm run cf:build
```

จากนั้นตั้ง continuous deployment:

1. Cloudflare Dashboard → **Workers & Pages** → **Create application**
2. เลือก **Import a repository** และ repository เดียวกับ Render
3. Worker name ต้องเป็น `ctwe-tournament` ให้ตรงกับ `wrangler.jsonc`
4. Production branch: `main`, Root directory: เว้นว่าง (repository root)
5. Build command: `npm run cf:build`
6. Deploy command: `npx wrangler deploy`
7. Non-production deploy command: `npx wrangler versions upload`
8. ตั้ง **Build variables and secrets**:

```text
NODE_VERSION=22.13.0
BACKEND_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

9. หลังสร้าง Worker ไปที่ **Settings → Variables & Secrets** แล้วเพิ่ม runtime variable:

```text
BACKEND_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

ต้องตั้ง `BACKEND_URL` ทั้ง Build และ Runtime; ห้ามชี้ production ไป `localhost` และ Render URL
ต้องเป็น HTTPS เมื่อ deploy สำเร็จให้เปิด `https://ctwe-tournament.YOUR-SUBDOMAIN.workers.dev`

Cloudflare route handlers proxy `/api`, `/login`, `/logout` ไป backend ทำให้ browser ใช้ session
cookie แบบ same-origin, ไม่ต้องเปิด CORS และยัง stream SSE ได้

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
- ตั้งผู้รับผิดชอบ monitor Render/Neon/Cloudflare dashboards
- สำหรับงาน 5,000 viewers ให้อัปเป็น Standard เฉพาะช่วงงาน แล้วลดกลับเป็น Starter หลังจบงาน
- ทำ capacity test และขั้นตอน warm cache ตาม `docs/EVENT_CAPACITY_RUNBOOK.md`
