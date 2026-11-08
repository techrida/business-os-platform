// Unit tests of the staff outcome route, with RecordOutcomeService mocked: the route passes both ids, the parsed
// body and the Idempotency-Key; a missing key or a bad body (accept without evidence, reject without a comment) is
// a 400 before the service is reached; the route needs quotation.record_acceptance; both ids carry a UUID pipe.
// The outcome rules themselves are in quotation-outcome.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { RecordOutcomeController } from './record-outcome.controller';
import { RecordOutcomeService } from './record-outcome.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const VID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const ACCEPT = {
  outcome: 'accepted',
  decidedOn: '2026-11-20',
  evidenceKinds: ['signed_quote'],
  expectedVersion: 4,
};
const REJECT = {
  outcome: 'rejected',
  decidedOn: '2026-11-20',
  comment: 'Went with another vendor',
  expectedVersion: 4,
};

async function setup() {
  const service = { record: vi.fn().mockResolvedValue({ id: 'acceptance-1' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [RecordOutcomeController],
    providers: [{ provide: RecordOutcomeService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(RecordOutcomeController) };
}

describe('RecordOutcomeController', () => {
  it('has no route without a permission marker, and record needs quotation.record_acceptance', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    expect(Reflect.getMetadata(CAN_KEY, RecordOutcomeController.prototype.record)).toBe(
      'quotation.record_acceptance',
    );
    await moduleRef.close();
  });

  it('records an acceptance with both ids, the parsed body and the key', async () => {
    const { service, controller } = await setup();
    await expect(controller.record(ID, VID, 'key-1', ACCEPT)).resolves.toEqual({
      id: 'acceptance-1',
    });
    expect(service.record).toHaveBeenCalledWith(ID, VID, ACCEPT, 'key-1');
  });

  it('records a rejection, defaulting the evidence kinds to none', async () => {
    const { service, controller } = await setup();
    await controller.record(ID, VID, 'key-2', REJECT);
    expect(service.record).toHaveBeenCalledWith(ID, VID, { ...REJECT, evidenceKinds: [] }, 'key-2');
  });

  it('answers 400, without calling the service, to a missing or bad key and to a bad body', async () => {
    const { service, controller } = await setup();
    expect(() => controller.record(ID, VID, undefined, ACCEPT)).toThrow(BadRequestException);
    expect(() => controller.record(ID, VID, '', ACCEPT)).toThrow(BadRequestException);
    for (const body of [
      { ...ACCEPT, evidenceKinds: [] },
      { ...ACCEPT, evidenceKinds: ['signed_quote', 'signed_quote'] },
      { ...ACCEPT, evidenceKinds: ['email'] },
      { ...REJECT, comment: undefined },
      { ...ACCEPT, outcome: 'expired' },
      { ...ACCEPT, decidedOn: '20-11-2026' },
      { ...ACCEPT, expectedVersion: undefined },
      { ...ACCEPT, actorKind: 'customer_user' },
      null,
    ]) {
      expect(() => controller.record(ID, VID, 'key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.record).not.toHaveBeenCalled();
  });

  it('checks the key before the body, so a missing key is the first thing reported', async () => {
    const { controller } = await setup();
    expect(() => controller.record(ID, VID, undefined, null)).toThrow(/Idempotency-Key/);
  });

  it('puts a UUID pipe on both ids, so a bad id is a 400 before the handler runs', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      RecordOutcomeController,
      'record',
    ) as Record<string, { index: number; pipes: unknown[] }>;
    const indexes = Object.values(args)
      .filter((arg) => arg.pipes.some((pipe) => pipe === ParseUUIDPipe))
      .map((arg) => arg.index)
      .sort();
    expect(indexes).toEqual([0, 1]);
  });
});
