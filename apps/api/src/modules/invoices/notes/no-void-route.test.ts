// D6 regression (P3 done check 12): an issued invoice is never voided; it is corrected with a credit or debit note. This
// reads the Nest route metadata of every invoice controller (the controller prefix and each handler's path) and fails if
// any route path or handler name says "void". The inline controller is a positive control: it proves the detector would
// catch such a route, so the check cannot pass by reading nothing.
import 'reflect-metadata';

import { Controller, Post } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { InvoicesController } from '../invoices.controller';
import { NotesController } from './notes.controller';

type ControllerClass = abstract new (...args: never[]) => object;

/** Every route of a controller as `prefix/path` with its handler name. */
function routesOf(controller: ControllerClass): { path: string; handler: string }[] {
  const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((handler) => {
    const fn = proto[handler];
    if (handler === 'constructor' || typeof fn !== 'function') return [];
    const path: unknown = Reflect.getMetadata(PATH_METADATA, fn);
    if (path === undefined) return [];
    const paths = (Array.isArray(path) ? path : [path]).filter(
      (p): p is string => typeof p === 'string',
    );
    return paths.map((p) => ({ path: `${prefix}/${p}`, handler }));
  });
}

const voidRoutes = (controller: ControllerClass) =>
  routesOf(controller).filter((r) => /void/i.test(r.path) || /void/i.test(r.handler));

@Controller('v1/invoices')
class ControlWithVoid {
  @Post(':id/void')
  voidInvoice(): void {}
}

describe('no void route on invoices (D6)', () => {
  it('the detector finds a void route when one exists (positive control)', () => {
    expect(voidRoutes(ControlWithVoid)).toEqual([
      { path: 'v1/invoices/:id/void', handler: 'voidInvoice' },
    ]);
  });

  it.each([
    ['InvoicesController', InvoicesController],
    ['NotesController', NotesController],
  ])('%s has routes and none of them voids', (_name, controller: ControllerClass) => {
    expect(routesOf(controller).length).toBeGreaterThan(0);
    expect(voidRoutes(controller)).toEqual([]);
  });

  it('the notes routes are exactly POST v1/credit-notes and v1/debit-notes', () => {
    expect(routesOf(NotesController).map((r) => r.path)).toEqual([
      'v1/credit-notes',
      'v1/debit-notes',
    ]);
  });
});
