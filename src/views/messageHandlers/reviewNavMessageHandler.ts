import { PendingEditReviewService } from '../../services/review/pendingEditReviewService';
import { IMessageHandler, WebviewMessageEmitter } from '../chatTypes';

/**
 * Handles inline-review navigation messages (prev/next change).
 */
export class ReviewNavMessageHandler implements IMessageHandler {
  readonly handledTypes = ['navigateReviewPrev', 'navigateReviewNext'] as const;

  constructor(
    private readonly emitter: WebviewMessageEmitter,
    private readonly reviewService?: PendingEditReviewService
  ) {}

  async handle(data: any): Promise<void> {
    const direction = data.type === 'navigateReviewPrev' ? 'prev' : 'next';
    try {
      const ids = data.checkpointIds || (data.checkpointId ? [data.checkpointId] : []);
      const pos = await this.reviewService?.navigateChange(direction, ids);
      if (pos) {
        this.emitter.postMessage({
          type: 'reviewChangePosition',
          checkpointId: ids[0],
          current: pos.current,
          total: pos.total,
          filePath: pos.filePath
        });
      }
    } catch (err: any) {
      console.error(`[ReviewNavHandler] navigate ${direction} failed:`, err);
    }
  }
}
