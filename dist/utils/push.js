"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPushToUser = sendPushToUser;
exports.notify = notify;
const web_push_1 = __importDefault(require("web-push"));
const supabase_js_1 = require("@supabase/supabase-js");
const env_1 = require("../config/env");
let vapidConfigured = false;
function ensureVapid() {
    if (vapidConfigured)
        return;
    if (!env_1.env.VAPID_PUBLIC_KEY || !env_1.env.VAPID_PRIVATE_KEY)
        return;
    web_push_1.default.setVapidDetails(env_1.env.VAPID_SUBJECT, env_1.env.VAPID_PUBLIC_KEY, env_1.env.VAPID_PRIVATE_KEY);
    vapidConfigured = true;
}
function getSupabase() {
    return (0, supabase_js_1.createClient)(env_1.env.SUPABASE_URL, env_1.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
    });
}
async function sendPushToUser(userId, payload) {
    ensureVapid();
    if (!vapidConfigured)
        return;
    const supabase = getSupabase();
    const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('user_id', userId);
    if (!subs?.length)
        return;
    const payloadStr = JSON.stringify(payload);
    for (const sub of subs) {
        try {
            await web_push_1.default.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payloadStr);
        }
        catch (err) {
            const status = err.statusCode;
            if (status === 410 || status === 404) {
                await supabase
                    .from('push_subscriptions')
                    .delete()
                    .eq('endpoint', sub.endpoint);
            }
        }
    }
}
async function notify(params) {
    const supabase = getSupabase();
    await supabase.from('wallet_notifications').insert({
        user_id: params.userId,
        type: params.type,
        title_fr: params.titleFr,
        title_en: params.titleEn,
        body_fr: params.bodyFr,
        body_en: params.bodyEn,
        data: params.data ?? {},
    });
    const { data: user } = await supabase
        .from('wallet_users')
        .select('notif_enabled, lang')
        .eq('id', params.userId)
        .maybeSingle();
    if (user?.notif_enabled === false)
        return;
    const lang = params.lang ?? user?.lang ?? 'fr';
    const title = lang === 'en' ? params.titleEn : params.titleFr;
    const body = lang === 'en' ? params.bodyEn : params.bodyFr;
    await sendPushToUser(params.userId, {
        title,
        body,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        tag: params.type,
        data: params.data,
    });
}
//# sourceMappingURL=push.js.map