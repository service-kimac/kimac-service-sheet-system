// supabase/functions/appointment-reminders/index.ts
//
// Edge Function: appointment-reminders
// -------------------------------------
// รันแบบ "scheduled" (ผ่าน pg_cron) ทุกวัน — ไม่ต้องพึ่งใครเปิดแอป
// หน้าที่: หาใบงาน (service_jobs) ที่ service_date = "พรุ่งนี้" และยังไม่เสร็จ
//          แล้วส่ง Web Push ไปยัง:
//            1) ช่างเจ้าของงาน (technician_id) คนนั้นๆ โดยตรง
//            2) แอดมินทุกคน (profiles.role = 'admin')
//
// ต้องตั้งค่า Environment Variables (Project Settings > Edge Functions > Secrets):
//   SUPABASE_URL              (มีให้อัตโนมัติ)
//   SUPABASE_SERVICE_ROLE_KEY (มีให้อัตโนมัติ) — ใช้ bypass RLS เพื่ออ่าน push_subscriptions ของทุกคน
//   VAPID_PUBLIC_KEY           = BIqAHXB1lUv5T_VO1O3t7ECi2TAoP8IdV5wOXWUGvRaq9CtFW5nAyksiDbHOS2CEtAQawloxSs62APX0tGCNpkc
//   VAPID_PRIVATE_KEY          = <private key คู่กับ public key ด้านบน — ต้องสร้างคู่ใหม่ ดูหมายเหตุท้ายไฟล์>
//   VAPID_SUBJECT              = mailto:admin@kimacthailand.com  (อีเมลติดต่อ ใส่อะไรก็ได้ที่เป็น mailto: หรือ URL)
//
// Deploy:
//   supabase functions deploy appointment-reminders --no-verify-jwt
//
// ตั้ง cron (รันทุกวันตอน 08:00 เวลาไทย = 01:00 UTC):
//   ดูไฟล์ setup.sql ที่แนบมาด้วย

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'https://esm.sh/web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com'

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function pad(n: number) { return String(n).padStart(2, '0') }

function bangkokTomorrowStr(): string {
  // เซิร์ฟเวอร์ของ Supabase Edge Functions รันด้วย UTC เสมอ
  // กรุงเทพฯ = UTC+7 จึงต้องบวกออฟเซ็ตก่อนคำนวณ "วันพรุ่งนี้ตามเวลาไทย"
  const now = new Date()
  const bkkNow = new Date(now.getTime() + 7 * 60 * 60 * 1000)
  const tomorrow = new Date(bkkNow)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return tomorrow.getUTCFullYear() + '-' + pad(tomorrow.getUTCMonth() + 1) + '-' + pad(tomorrow.getUTCDate())
}

async function sendPushToUser(userId: string, payload: Record<string, unknown>) {
  const { data: subs, error } = await sb
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId)

  if (error) {
    console.error('fetch subs error for user', userId, error.message)
    return { sent: 0, failed: 0 }
  }
  if (!subs || !subs.length) return { sent: 0, failed: 0 }

  let sent = 0, failed = 0
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        },
        JSON.stringify(payload)
      )
      sent++
    } catch (e: any) {
      failed++
      // endpoint หมดอายุ/ถูกถอนสิทธิ์ -> ลบทิ้งกันขยะสะสม (เฉพาะ error code มาตรฐานของ web push)
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      } else {
        console.error('push send error', userId, e?.message || e)
      }
    }
  }
  return { sent, failed }
}

Deno.serve(async (_req) => {
  try {
    const tomorrowStr = bangkokTomorrowStr()

    // 1) ดึงใบงานที่นัดพรุ่งนี้ และยังไม่เสร็จ และยังไม่ถูกลบ
    const { data: jobs, error: jobsErr } = await sb
      .from('service_jobs')
      .select('id, job_no, company, service_location, time_start, technician_id, technician_name, status, deleted_at, service_date')
      .eq('service_date', tomorrowStr)
      .is('deleted_at', null)
      .neq('status', 'completed')

    if (jobsErr) throw jobsErr
    if (!jobs || !jobs.length) {
      return new Response(JSON.stringify({ ok: true, date: tomorrowStr, jobs: 0, message: 'ไม่มีนัดหมายพรุ่งนี้' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2) ดึงรายชื่อแอดมินทั้งหมด (ครั้งเดียว ใช้ร่วมกันทุกใบงาน)
    const { data: admins, error: adminErr } = await sb
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
    if (adminErr) throw adminErr
    const adminIds = (admins || []).map((a) => a.id)

    let totalTechSent = 0, totalAdminSent = 0, totalFailed = 0
    const results: Record<string, unknown>[] = []

    for (const j of jobs) {
      const jobNo = j.job_no || ('#' + j.id)
      const company = j.company || 'ลูกค้า'
      const loc = j.service_location || ''
      const timeStr = j.time_start ? (' เวลา ' + j.time_start + ' น.') : ''
      const title = '📅 นัดหมายพรุ่งนี้'
      const bodyTech = jobNo + ' · ' + company + (loc ? ' · ' + loc : '') + timeStr
      const bodyAdmin = bodyTech + (j.technician_name ? (' · 🔧 ' + j.technician_name) : '')

      // ส่งให้ช่างเจ้าของงานคนนั้นๆ โดยตรง
      let techResult = { sent: 0, failed: 0 }
      if (j.technician_id) {
        techResult = await sendPushToUser(j.technician_id, {
          title,
          body: bodyTech,
          tag: 'appt_' + j.id,
          data: { type: 'appt_remind', job_id: j.id, url: '/kimac-service-sheet-system/history.html' },
        })
      }

      // ส่งให้แอดมินทุกคน (ยกเว้นกรณีแอดมินคนนั้นเป็นเจ้าของงานเองอยู่แล้ว จะได้ไม่ซ้ำ 2 ครั้ง)
      let adminSent = 0, adminFailed = 0
      for (const aid of adminIds) {
        if (aid === j.technician_id) continue
        const r = await sendPushToUser(aid, {
          title,
          body: bodyAdmin,
          tag: 'appt_admin_' + j.id,
          data: { type: 'appt_remind', job_id: j.id, url: '/kimac-service-sheet-system/history.html' },
        })
        adminSent += r.sent
        adminFailed += r.failed
      }

      totalTechSent += techResult.sent
      totalAdminSent += adminSent
      totalFailed += techResult.failed + adminFailed

      results.push({
        job_id: j.id, job_no: jobNo, technician_id: j.technician_id,
        tech_push_sent: techResult.sent, admin_push_sent: adminSent,
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      date: tomorrowStr,
      jobs: jobs.length,
      tech_push_sent: totalTechSent,
      admin_push_sent: totalAdminSent,
      failed: totalFailed,
      details: results,
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e: any) {
    console.error('appointment-reminders error:', e)
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
