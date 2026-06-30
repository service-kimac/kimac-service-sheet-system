-- ==========================================================================
-- setup.sql — ตั้งตารางเวลาให้ Edge Function "appointment-reminders" รันอัตโนมัติทุกวัน
-- ==========================================================================
-- รันสคริปต์นี้ใน Supabase Dashboard > SQL Editor (เลือก project ที่ใช้กับแอป)
--
-- ขั้นตอนก่อนรันสคริปต์นี้:
--   1) Deploy edge function ชื่อ "appointment-reminders" ให้เรียบร้อยก่อน
--      (ดูคำสั่งใน index.ts ด้านบน หรือใช้ Supabase CLI:
--         supabase functions deploy appointment-reminders --no-verify-jwt)
--   2) ตั้งค่า Secrets ของ project (Project Settings > Edge Functions):
--         VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
--      (วิธีสร้างคู่ VAPID key ใหม่ ดูหมายเหตุท้ายไฟล์นี้)
--   3) คัดลอก URL ของ project (เช่น https://vjblfdlzerpiazmqxuce.supabase.co)
--      และ anon key หรือ service role key มาแทนที่ <YOUR_PROJECT_REF> และ <YOUR_ANON_KEY> ด้านล่าง

-- 1) เปิด extension ที่จำเป็น (ถ้ายังไม่เคยเปิด)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) ลบ job เดิมถ้ามี (กันสร้างซ้ำตอนรันสคริปต์นี้รอบสอง)
select cron.unschedule('appointment-reminders-daily')
where exists (select 1 from cron.job where jobname = 'appointment-reminders-daily');

-- 3) ตั้งเวลารัน: ทุกวันตอน 08:00 น. เวลาไทย (เวลาไทย = UTC+7 ดังนั้นต้องตั้งเป็น 01:00 UTC)
--    cron syntax: นาที ชั่วโมง วัน เดือน วันในสัปดาห์ (เวลาทั้งหมดเป็น UTC)
select cron.schedule(
  'appointment-reminders-daily',
  '0 1 * * *',  -- 01:00 UTC = 08:00 น. เวลาไทย ทุกวัน
  $$
  select net.http_post(
    url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/appointment-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <YOUR_ANON_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 4) ตรวจสอบว่าตั้งสำเร็จ
select * from cron.job where jobname = 'appointment-reminders-daily';

-- (ทางเลือก) ดูประวัติการรันล่าสุด เผื่อ debug ว่ารันจริงไหม
-- select * from cron.job_run_details order by start_time desc limit 10;


-- ==========================================================================
-- คู่ VAPID key ที่สร้างไว้ให้แล้ว (พร้อมใช้งานได้เลย)
-- ==========================================================================
-- Public Key  (ใส่ใน history.html ตัวแปร VAPID_PUBLIC แล้วเรียบร้อย):
--   BMr6dxid3T14gg7eJHwJ-VSFVb95y7qKYQxUWdvSgdLvFvvyvVkWK2zk1Q7_Usd2stZb3o26ty8ewrFs5dHu1jg
--
-- Private Key (เอาไปตั้งเป็น Secret ชื่อ VAPID_PRIVATE_KEY ใน Supabase Edge Functions):
--   mgJ7UC381EYRxH-gTMSNEcN9heCbVY41z7RyFYVjo3M
--
-- *** เก็บ Private Key นี้เป็นความลับ ห้ามใส่ในโค้ดฝั่ง client (history.html) เด็ดขาด ***
-- *** ผู้ใช้ทุกคนที่เคยเปิดแจ้งเตือนไว้แล้วด้วย public key ตัวเก่า ต้องปิด-เปิดสวิตช์
--     แจ้งเตือนใหม่อีกครั้ง 1 ครั้ง (หน้าตั้งค่า > เปิดแจ้งเตือนงานใหม่) มิฉะนั้น
--     subscription เดิมจะใช้ไม่ได้แล้วเพราะผูกกับ public key คนละคู่กัน ***
-- ==========================================================================
