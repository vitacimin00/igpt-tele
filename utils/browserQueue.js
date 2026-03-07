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
        this.onUpdate = null; // callback for status updates
    }

    /**
     * Add a task to the queue
     * @param {object} task - { type, accountId, fn, resolve, reject, meta }
     * @returns {Promise} resolves when task completes
     */
    add(type, accountId, fn, meta = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                type,        // 'invite', 'kick', 'login', 'billing'
                accountId,   // group key for batching
                fn,          // async function to execute
                resolve,
                reject,
                meta,        // extra info (email, chatId, etc)
                addedAt: Date.now()
            });

            console.log(`📋 Queue: +${type} (${meta.email || accountId}) | total: ${this.queue.length}`);

            // Notify about position if callback set
            if (this.onUpdate) {
                const position = this.queue.length;
                this.onUpdate({ type: 'queued', position, meta });
            }

            // Start processing if not already
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
            // Peek first task to determine account
            const currentAccountId = this.queue[0].accountId;
            const currentType = this.queue[0].type;

            // Collect all tasks for the same account AND same type (batch invites)
            const batch = [];
            const remaining = [];

            for (const task of this.queue) {
                if (task.accountId === currentAccountId && task.type === currentType && currentType === 'invite') {
                    batch.push(task);
                } else if (batch.length === 0 && task === this.queue[0]) {
                    // First non-batchable task — take it alone
                    batch.push(task);
                    break;
                } else {
                    remaining.push(task);
                }
            }

            // Update queue to remaining
            this.queue = remaining;

            if (batch.length > 1) {
                console.log(`📦 Batch: ${batch.length} invites for account ${currentAccountId}`);
            }

            // Execute batch (with timeout per task)
            for (const task of batch) {
                try {
                    const TIMEOUT = 3 * 60 * 1000; // 3 minutes max per task
                    const result = await Promise.race([
                        task.fn(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('⏰ Timeout: browser operation took too long (3 min)')), TIMEOUT)
                        )
                    ]);
                    task.resolve(result);
                } catch (error) {
                    console.error(`❌ Queue task failed: ${error.message}`);
                    task.resolve({ success: false, message: error.message });
                }
            }
        }

        this.processing = false;
    }
}

export default BrowserQueue;
