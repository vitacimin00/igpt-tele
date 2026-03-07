import fs from 'fs';

class VoucherManager {
    constructor() {
        this.vouchersFile = 'data/vouchers.json';
        if (!fs.existsSync(this.vouchersFile)) {
            fs.writeFileSync(this.vouchersFile, JSON.stringify({ vouchers: [] }, null, 2));
        }
    }

    load() {
        try {
            return JSON.parse(fs.readFileSync(this.vouchersFile, 'utf8'));
        } catch (e) {
            return { vouchers: [] };
        }
    }

    save(data) {
        fs.writeFileSync(this.vouchersFile, JSON.stringify(data, null, 2));
    }

    /**
     * Create a new voucher
     * @param {string} code - Voucher code (uppercase)
     * @param {string} type - 'percent' or 'fixed'
     * @param {number} value - discount value (50 = 50% or Rp 5000)
     * @param {number} maxUses - max redemptions (-1 = unlimited)
     * @param {string|null} expiresAt - expiry date ISO string or null
     */
    createVoucher(code, type, value, maxUses = -1, expiresAt = null) {
        const data = this.load();
        code = code.toUpperCase().trim();

        if (data.vouchers.find(v => v.code === code)) {
            return { success: false, message: 'Kode voucher sudah ada!' };
        }

        data.vouchers.push({
            code,
            type,         // 'percent' or 'fixed'
            value,        // discount amount
            maxUses,      // -1 = unlimited
            usedCount: 0,
            claimedBy: [], // [{ userId, claimedAt }]
            usedBy: [],    // [{ userId, usedAt }]
            expiresAt,
            active: true,
            createdAt: new Date().toISOString()
        });

        this.save(data);
        return { success: true, message: `✅ Voucher ${code} berhasil dibuat!` };
    }

    /**
     * User claims a voucher (reserves it)
     */
    claimVoucher(code, userId) {
        const data = this.load();
        code = code.toUpperCase().trim();
        const voucher = data.vouchers.find(v => v.code === code);

        if (!voucher) return { success: false, message: 'Kode voucher tidak ditemukan.' };
        if (!voucher.active) return { success: false, message: 'Voucher sudah tidak aktif.' };

        // Check expiry
        if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
            return { success: false, message: 'Voucher sudah expired.' };
        }

        // Check max uses
        if (voucher.maxUses !== -1 && (voucher.usedCount + voucher.claimedBy.length) >= voucher.maxUses) {
            return { success: false, message: 'Voucher sudah habis.' };
        }

        // Check if already claimed by this user
        const alreadyClaimed = voucher.claimedBy.find(c => c.userId === userId);
        if (alreadyClaimed) {
            return { success: false, message: 'Kamu sudah claim voucher ini.' };
        }

        // Check if already used by this user
        const alreadyUsed = voucher.usedBy.find(u => u.userId === userId);
        if (alreadyUsed) {
            return { success: false, message: 'Kamu sudah pernah pakai voucher ini.' };
        }

        voucher.claimedBy.push({ userId, claimedAt: new Date().toISOString() });
        this.save(data);

        return {
            success: true,
            message: `✅ Voucher ${code} berhasil di-apply!`,
            voucher: {
                code: voucher.code,
                type: voucher.type,
                value: voucher.value
            }
        };
    }

    /**
     * Mark voucher as fully used after successful payment
     */
    useVoucher(code, userId) {
        const data = this.load();
        code = code.toUpperCase().trim();
        const voucher = data.vouchers.find(v => v.code === code);
        if (!voucher) return;

        // Move from claimedBy to usedBy
        voucher.claimedBy = voucher.claimedBy.filter(c => c.userId !== userId);
        voucher.usedBy.push({ userId, usedAt: new Date().toISOString() });
        voucher.usedCount++;
        this.save(data);
    }

    /**
     * Return voucher (if payment cancelled/expired)
     */
    returnVoucher(code, userId) {
        const data = this.load();
        code = code.toUpperCase().trim();
        const voucher = data.vouchers.find(v => v.code === code);
        if (!voucher) return;

        voucher.claimedBy = voucher.claimedBy.filter(c => c.userId !== userId);
        this.save(data);
    }

    /**
     * Get user's active (claimed) voucher
     */
    getUserVoucher(userId) {
        const data = this.load();
        for (const voucher of data.vouchers) {
            const claim = voucher.claimedBy.find(c => c.userId === userId);
            if (claim && voucher.active) {
                return {
                    code: voucher.code,
                    type: voucher.type,
                    value: voucher.value
                };
            }
        }
        return null;
    }

    /**
     * Remove user's active voucher claim
     */
    removeUserVoucher(userId) {
        const data = this.load();
        for (const voucher of data.vouchers) {
            voucher.claimedBy = voucher.claimedBy.filter(c => c.userId !== userId);
        }
        this.save(data);
    }

    /**
     * Calculate discounted price
     */
    applyDiscount(price, voucher) {
        if (!voucher) return price;
        if (voucher.type === 'percent') {
            return Math.round(price * (1 - voucher.value / 100));
        } else {
            return Math.max(0, price - voucher.value);
        }
    }

    /**
     * Format discount label
     */
    formatDiscount(voucher) {
        if (!voucher) return '';
        if (voucher.type === 'percent') return `-${voucher.value}%`;
        return `-${voucher.value.toLocaleString('id-ID')}`;
    }

    listVouchers() {
        return this.load().vouchers;
    }

    deleteVoucher(code) {
        const data = this.load();
        code = code.toUpperCase().trim();
        const idx = data.vouchers.findIndex(v => v.code === code);
        if (idx === -1) return { success: false, message: 'Voucher tidak ditemukan.' };
        data.vouchers.splice(idx, 1);
        this.save(data);
        return { success: true, message: `✅ Voucher ${code} dihapus.` };
    }
}

export default VoucherManager;
