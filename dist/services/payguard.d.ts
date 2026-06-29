export declare function enrollPayGuard(params: {
    selfie_b64: string;
    first_name: string;
    last_name: string;
}): Promise<{
    student_id: string;
    confidence: number;
}>;
export declare function verifyPayGuard(params: {
    selfie_b64: string;
    first_name: string;
    last_name: string;
    student_id: string;
}): Promise<{
    verified: boolean;
    similarity: number;
}>;
