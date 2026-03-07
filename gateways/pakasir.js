import axios from 'axios';

const PAKASIR_BASE_URL = 'https://app.pakasir.com/api';
const getKey = () => process.env.PAKASIR_API_KEY;
const getSlug = () => process.env.PAKASIR_SLUG;

/**
 * Create QRIS payment via PaKasir
 */
export async function createPayment(orderId, amount) {
    try {
        const response = await axios.post(
            `${PAKASIR_BASE_URL}/transactioncreate/qris`,
            {
                project: getSlug(),
                order_id: orderId,
                amount: amount,
                api_key: getKey()
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );

        const paymentData = response.data.payment || response.data;

        if (paymentData && paymentData.payment_number) {
            return {
                success: true,
                data: {
                    order_id: paymentData.order_id,
                    qris_string: paymentData.payment_number,
                    amount: paymentData.amount,
                    fee: paymentData.fee || 0,
                    total_payment: paymentData.total_payment || paymentData.amount,
                    expired_at: paymentData.expired_at
                }
            };
        }

        return { success: false, error: response.data?.message || 'Failed to create QRIS' };
    } catch (error) {
        console.error('[PaKasir] Create Error:', error.response?.data || error.message);
        return { success: false, error: error.response?.data?.message || error.message };
    }
}

/**
 * Check payment status
 */
export async function checkStatus(orderId, amount) {
    try {
        const response = await axios.get(`${PAKASIR_BASE_URL}/transactiondetail`, {
            params: {
                project: getSlug(),
                order_id: orderId,
                amount: amount,
                api_key: getKey()
            },
            timeout: 10000
        });

        const txData = response.data.transaction || response.data;

        if (txData && txData.status) {
            return {
                success: true,
                status: txData.status, // 'pending' | 'completed' | 'expired'
                completed_at: txData.completed_at
            };
        }

        return { success: false, error: 'Unknown status' };
    } catch (error) {
        console.error('[PaKasir] Status Error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Cancel payment
 */
export async function cancelPayment(orderId) {
    try {
        const response = await axios.post(
            `${PAKASIR_BASE_URL}/transactioncancel`,
            {
                project: getSlug(),
                order_id: orderId,
                api_key: getKey()
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        return { success: true, data: response.data };
    } catch (error) {
        console.error('[PaKasir] Cancel Error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Handle webhook callback from PaKasir
 */
export function handleWebhook(webhookData) {
    const { order_id, status, amount, payment_method, completed_at, project } = webhookData;

    if (project && project !== getSlug()) {
        return { success: false, error: 'Project mismatch' };
    }

    return {
        success: true,
        orderId: order_id,
        status,
        amount,
        paymentMethod: payment_method,
        completedAt: completed_at
    };
}

/**
 * Generate QR image URL from QR string
 */
export function getQRImageUrl(qrString) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrString)}`;
}

/**
 * Gateway info
 */
export const gatewayName = 'PaKasir';
export const gatewayId = 'pakasir';
