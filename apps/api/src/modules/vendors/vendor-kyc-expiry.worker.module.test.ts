import { describe, expect, it, vi } from 'vitest';

import type { VendorKycExpiryService } from './vendor-kyc-expiry.service';
import {
  VENDOR_KYC_EXPIRY_CRON,
  VENDOR_KYC_EXPIRY_JOB,
  VENDOR_KYC_EXPIRY_TZ,
  VendorKycExpiryProcessor,
  VendorKycExpiryScheduler,
} from './vendor-kyc-expiry.worker.module';

describe('VendorKycExpiryProcessor', () => {
  it('runs the expiry check for the run job and refuses any other job name', async () => {
    const expiry = { run: vi.fn().mockResolvedValue({ suspended: ['v1'] }) };
    const processor = new VendorKycExpiryProcessor(expiry as unknown as VendorKycExpiryService);
    await expect(processor.process({ name: VENDOR_KYC_EXPIRY_JOB } as never)).resolves.toEqual({
      suspended: ['v1'],
    });
    expect(expiry.run).toHaveBeenCalledTimes(1);
    await expect(processor.process({ name: 'something.else' } as never)).rejects.toThrow(
      /Unknown vendor KYC expiry job/,
    );
    expect(expiry.run).toHaveBeenCalledTimes(1);
  });
});

describe('VendorKycExpiryScheduler', () => {
  it('registers one daily 01:00 Asia/Kathmandu job through upsertJobScheduler (idempotent across restarts)', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
    await new VendorKycExpiryScheduler(queue as never).onApplicationBootstrap();
    expect(VENDOR_KYC_EXPIRY_CRON).toBe('0 1 * * *');
    expect(VENDOR_KYC_EXPIRY_TZ).toBe('Asia/Kathmandu');
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'vendors.kyc-expiry.run',
      { pattern: '0 1 * * *', tz: 'Asia/Kathmandu' },
      expect.objectContaining({ name: 'vendors.kyc-expiry.run' }),
    );
  });
});
