import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

function getSupabase() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

export interface NotificationPayload {
  title: string;
  body:  string;
  icon?: string;
  badge?: string;
  tag?:  string;
  data?: Record<string, unknown>;
}

export async function sendPushToUser(
  userId: string,
  payload: NotificationPayload
): Promise<void> {
  ensureVapid();
  if (!vapidConfigured) return;

  const supabase = getSupabase();
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (!subs?.length) return;

  const payloadStr = JSON.stringify(payload);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payloadStr
      );
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 410 || status === 404) {
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('endpoint', sub.endpoint);
      }
    }
  }
}

export async function notify(params: {
  userId:  string;
  type:    string;
  titleFr: string;
  titleEn: string;
  bodyFr:  string;
  bodyEn:  string;
  data?:   Record<string, unknown>;
  lang?:   string;
}): Promise<void> {
  const supabase = getSupabase();

  await supabase.from('wallet_notifications').insert({
    user_id:  params.userId,
    type:     params.type,
    title_fr: params.titleFr,
    title_en: params.titleEn,
    body_fr:  params.bodyFr,
    body_en:  params.bodyEn,
    data:     params.data ?? {},
  });

  const { data: user } = await supabase
    .from('wallet_users')
    .select('notif_enabled, lang')
    .eq('id', params.userId)
    .maybeSingle();

  if (user?.notif_enabled === false) return;

  const lang  = params.lang ?? user?.lang ?? 'fr';
  const title = lang === 'en' ? params.titleEn : params.titleFr;
  const body  = lang === 'en' ? params.bodyEn  : params.bodyFr;

  await sendPushToUser(params.userId, {
    title,
    body,
    icon:  '/icons/icon-192x192.png',
    badge: '/icons/badge-72x72.png',
    tag:   params.type,
    data:  params.data,
  });
}
