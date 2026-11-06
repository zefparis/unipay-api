export interface NotificationPayload {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    tag?: string;
    data?: Record<string, unknown>;
}
export declare function sendPushToUser(userId: string, payload: NotificationPayload): Promise<void>;
export declare function notify(params: {
    userId: string;
    type: string;
    titleFr: string;
    titleEn: string;
    bodyFr: string;
    bodyEn: string;
    data?: Record<string, unknown>;
    lang?: string;
}): Promise<void>;
