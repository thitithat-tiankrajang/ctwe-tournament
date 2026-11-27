# เปิด CTWE บนเครื่องเพื่อทดสอบหน้าตาและระบบจริง

| สิ่งที่เปิด | ที่อยู่ | ข้อมูล |
| --- | --- | --- |
| แอปจริง Next.js / React | http://127.0.0.1:3319 | อ่านและบันทึกผ่าน Spring Boot และ PostgreSQL |
| Spring Boot | http://127.0.0.1:18219/actuator/health | API, ยืนยันตัวตน และการอัปเดตสด |
| PostgreSQL | `127.0.0.1:54339` | ฐานข้อมูลทดสอบแยก เก็บใน Docker volume `ctwe-ui-postgres-data` |
| ต้นแบบ revision 19 | http://127.0.0.1:4317/?role=viewer | ข้อมูลจำลอง เปิดได้ด้วย Python |

## เปิดแอปจริงชุดที่เตรียมไว้บนเครื่องนี้

เครื่องมือต้องมี Docker Desktop, Node.js ตาม `.nvmrc`, Java 17 และ Maven 3.9 ขึ้นไป เช็กว่า [API พร้อม](http://127.0.0.1:18219/actuator/health) และ [หน้าเข้าสู่ระบบ](http://127.0.0.1:3319/staff-login) เปิดได้ก่อนสั่งรันซ้ำ

เปิด Docker Desktop แล้วรันใน Terminal แรก

```bash
docker start ctwe-ui-postgres
cd ~/Desktop/CTWE/backend
set -a
source ~/.ctwe-local/prototype-port.env
set +a
mvn spring-boot:run
```

รอข้อความ `Started` หรือตรวจด้วย `curl -fsS http://127.0.0.1:18219/actuator/health` ควรขึ้น `"status":"UP"`

เปิด Terminal ที่สองสำหรับ React

```bash
cd ~/Desktop/CTWE
nvm use                       # ใช้เมื่อเครื่องติดตั้ง nvm
npm ci                        # ครั้งแรกหรือเมื่อ package-lock.json เปลี่ยน
BACKEND_URL=http://127.0.0.1:18219 \
  NEXT_PUBLIC_PUBLIC_API_ORIGIN='' NEXT_PUBLIC_SNAPSHOT_ORIGIN='' \
  NEXT_DIST_DIR=.next/ctwe-ui-dev \
  npm run dev -- --hostname 127.0.0.1 --port 3319
```

เปิด [เข้าสู่ระบบ](http://127.0.0.1:3319/staff-login) หรือ [ลิงก์ผู้ชมของสนามทดสอบ](http://127.0.0.1:3319/tour/ctwe-ui-local) ใช้ `127.0.0.1` เหมือนกันตลอดเพื่อให้คุกกี้ของเซสชันตรงกัน ไม่ต้องตั้ง CORS สำหรับการเข้าผ่าน Next.js ที่ส่งต่อ API ให้ Spring Boot

### บัญชีและการลองงานพร้อมกัน

บัญชีทดสอบมีชื่อ `ctwe-local-admin`, `ctwe-local-director` และ `ctwe-local-staff` รหัสของเครื่องนี้อยู่ใน `~/.ctwe-local/prototype-port-accounts.env` เปิดด้วย `open -e ~/.ctwe-local/prototype-port-accounts.env` เก็บไฟล์นี้ไว้นอก git

1. เปิดสอง browser profiles หรือเบราว์เซอร์ปกติกับ Incognito คนละเซสชัน แล้วเข้าสู่ระบบด้วย Staff และ Director
2. เลือก **CTWE · สนามทดสอบ** และรุ่น **A-Math · ประถมศึกษา** ทั้งสองฝั่ง หรือใช้ [กรอกผล](http://127.0.0.1:3319/cards/dc539442-4783-4788-b19f-5e36c559c17a/games) และ [โต๊ะแข่งขัน](http://127.0.0.1:3319/cards/dc539442-4783-4788-b19f-5e36c559c17a/tables)
3. ให้ Director เปิด **Multi Switching** แล้วให้ Staff บันทึกคู่ที่ยังรอผล ดูว่าคู่ในหน้าต่างของ Director ขึ้นว่ากรอกผลแล้วและปุ่มเลือกที่นั่งถูกล็อกโดยไม่ต้องรีเฟรช
4. ตรวจรายการจาก **บันทึกกิจกรรม** ที่ Director เห็น และเปิด Viewer แบบไม่ล็อกอินเพื่อดูสิ่งที่เผยแพร่แล้ว

สนามนี้ใช้ข้อมูลสำหรับลองระบบโดยเฉพาะ คู่ใน A-Math บางคู่มีคะแนนจากการทดสอบแล้ว ให้เลือกคู่ที่ยังรอผลเมื่ออยากลองบันทึก คะแนนที่บันทึกจะอยู่ต่อหลังรีเฟรชหรือปิดเครื่อง

หยุด Next.js และ Spring Boot ด้วย `Ctrl+C` ในแต่ละ Terminal หยุด PostgreSQL ด้วย `docker stop ctwe-ui-postgres` ข้อมูลยังอยู่ใน Docker volume เปิดกลับมาได้ด้วยคำสั่งเดิม

### สร้างฐานทดสอบใหม่บนเครื่องอื่น

สร้างไฟล์ environment ในโฟลเดอร์ส่วนตัวแทนการอ่าน `.env.production` ใส่รหัสผ่านฐานข้อมูลจาก `openssl rand -hex 24` และใส่ BCrypt cost 12 ของรหัสที่ต้องการใช้เป็น Admin ตรวจสอบว่าครอบ hash ด้วย single quotes เพื่อเก็บตัวอักษร `$` ตามเดิม

```bash
umask 077
mkdir -p ~/.ctwe-local
htpasswd -nBC 12 ctwe-local-admin
```

สร้าง `~/.ctwe-local/prototype-port.env` แล้วใส่ค่าต่อไปนี้

```bash
DATABASE_PASSWORD='ใส่รหัสฐานข้อมูลที่สร้าง'
DATABASE_URL='jdbc:postgresql://127.0.0.1:54339/tournament'
DATABASE_USER='tournament_app'
PORT=18219
SERVER_ADDRESS='127.0.0.1'
STAFF_USERNAME='ctwe-local-admin'
STAFF_PASSWORD_HASH='ใส่เฉพาะ BCrypt หลังเครื่องหมาย : จาก htpasswd'
SESSION_COOKIE_SECURE=false
CORS_ALLOWED_ORIGINS='http://127.0.0.1:3319'
```

เปิด Docker Desktop แล้วสร้าง container ครั้งแรก

```bash
source ~/.ctwe-local/prototype-port.env
POSTGRES_PASSWORD="$DATABASE_PASSWORD" docker run -d --name ctwe-ui-postgres \
  -p 127.0.0.1:54339:5432 --env POSTGRES_PASSWORD \
  -e POSTGRES_USER=tournament_app -e POSTGRES_DB=tournament \
  -v ctwe-ui-postgres-data:/var/lib/postgresql/data postgres:17-alpine
```

จากนั้นเปิด Spring Boot และ Next.js ตามขั้นตอนเดิม Spring Boot ใช้ Flyway สร้างตารางเมื่อเริ่มครั้งแรก เข้าสู่ระบบด้วยบัญชี bootstrap Admin เพื่อสร้างรายการแข่งขันและผูก Director แล้วใช้บัญชี Director สร้าง Staff และให้สิทธิ์เข้ารายการเดียวกัน

## เปิดต้นแบบ revision 19

```bash
cd ~/Desktop/CTWE-prototype/site
python3 -m http.server 4317 --bind 127.0.0.1
```

ถ้าเปิดอยู่แล้วใช้ลิงก์เดิมได้เลย `lsof -nP -iTCP:4317 -sTCP:LISTEN` ใช้ตรวจสถานะ

- [Viewer](http://127.0.0.1:4317/?role=viewer)
- [Director](http://127.0.0.1:4317/?role=director)
- [Staff](http://127.0.0.1:4317/?role=staff)
- [Admin](http://127.0.0.1:4317/?role=admin)

เปิดผ่าน HTTP เพราะต้นแบบโหลด `icons.js` และใช้ประวัติการนำทางของเบราว์เซอร์ ข้อมูลในต้นแบบเป็นข้อมูลจำลอง ส่วนแอปจริงชุดทดสอบบันทึกข้อมูลใน PostgreSQL แยก

## รายละเอียดที่ต่างจากต้นแบบ

- Viewer ใช้สเกล 100% บนมือถือ ย้ายโรงเรียนเป็นคอลัมน์เมื่อพื้นที่พอ และรับคำค้นอย่าง `A001, A003`, `เกม 1`, `คู่ที่ 2` หรือ `ที่นั่ง 3` สำหรับข้อมูลที่เผยแพร่แล้ว
- API สาธารณะส่งวิธีจับคู่ในเกมแรกกับ Max diff รายเกม รายละเอียดวิธีจับคู่ช่วงเกมถัดไปยังไม่มีในข้อมูลสาธารณะ
- สีประจำกีฬาที่ Admin ตั้งจากเครื่องหนึ่งแล้ว Viewer ทุกเครื่องเห็น การลบผู้เล่นหลายคนในครั้งเดียว และคำอธิบายหลักฐานการันตีอันดับแบบ Gibson ยังอยู่ในต้นแบบ ส่วนแอปจริงแสดงผลตามข้อมูลที่ API ส่งให้
