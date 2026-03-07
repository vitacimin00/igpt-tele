/**
 * Payment Gateway Router
 * Reads PAYMENT_GATEWAY from .env and loads the corresponding gateway module.
 * 
 * Each gateway must export:
 * - createPayment(orderId, amount) → { success, data: { qris_string, amount, fee, expired_at } }
 * - checkStatus(orderId, amount) → { success, status: 'pending'|'completed'|'expired' }
 * - cancelPayment(orderId) → { success }
 * - handleWebhook(data) → { success, orderId, status, amount }
 * - getQRImageUrl(qrString) → string (URL to QR image)
 * - gatewayName → string
 * - gatewayId → string
 */

const GATEWAY = process.env.PAYMENT_GATEWAY || 'pakasir';

let gateway;

switch (GATEWAY) {
    case 'pakasir':
        gateway = await import('./pakasir.js');
        break;
    // case 'midtrans':
    //     gateway = await import('./midtrans.js');
    //     break;
    // case 'xendit':
    //     gateway = await import('./xendit.js');
    //     break;
    default:
        throw new Error(`Unknown payment gateway: ${GATEWAY}`);
}

export const createPayment = gateway.createPayment;
export const checkStatus = gateway.checkStatus;
export const cancelPayment = gateway.cancelPayment;
export const handleWebhook = gateway.handleWebhook;
export const getQRImageUrl = gateway.getQRImageUrl;
export const gatewayName = gateway.gatewayName;
export const gatewayId = gateway.gatewayId;
