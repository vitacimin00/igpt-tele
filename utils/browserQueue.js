/**
 * Browser Operation Queue
 * - All browser ops (invite, kick, login, billing) go through this queue
 * - Groups invites by account — same account batch in 1 browser session
 * - Max 1 browser running at any time
 */
class BrowserQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.onUpdate = null;
        this._service = null; // chatgptService reference for killing browsers
    }

    setService(service) {
        this._service = service;
    }

    /**
     * Add a task to the queue
     * @param {object} task - { type, accountId, fn, resolve, reject, meta }
     * @returns {Promise} resolves when task completes
     */
    add(type, accountId, fn, meta = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                type,
                accountId,
                fn,
                resolve,
                reject,
                meta,
                addedAt: Date.now()
            });

            console.log(`📋 Queue: +${type} (${meta.email || accountId}) | total: ${this.queue.length}`);

            if (this.onUpdate) {
                const position = this.queue.length;
                this.onUpdate({ type: 'queued', position, meta });
            }

            if (!this.processing) {
                this.process();
            }
        });
    }

    getPosition(meta) {
        return this.queue.findIndex(t => t.meta?.email === meta?.email) + 1;
    }

    getQueueLength() {
        return this.queue.length;
    }

    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const currentAccountId = this.queue[0].accountId;
            const currentType = this.queue[0].type;

            const batch = [];
            const remaining = [];

            for (const task of this.queue) {
                if (task.accountId === currentAccountId && task.type === currentType && currentType === 'invite') {
                    batch.push(task);
                } else if (batch.length === 0 && task === this.queue[0]) {
                    batch.push(task);
                    break;
                } else {
                    remaining.push(task);
                }
            }

            this.queue = remaining;

            if (batch.length > 1) {
                console.log(`📦 Batch: ${batch.length} invites for account ${currentAccountId}`);
            }

            // Execute batch (with timeout per task)
            for (const task of batch) {
                try {
                    const TIMEOUT = 3 * 60 * 1000; // 3 minutes max
                    const result = await Promise.race([
                        task.fn(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('⏰ Timeout: browser operation took too long (3 min)')), TIMEOUT)
                        )
                    ]);
                    task.resolve(result);
                } catch (error) {
                    console.error(`❌ Queue task failed: ${error.message}`);
                    // Kill zombie browser on timeout/error
                    if (this._service) {
                        await this._service.killActiveBrowser();
                    }
                    task.resolve({ success: false, message: error.message });
                }
            }
        }

        this.processing = false;
    }
}

export default BrowserQueue;
