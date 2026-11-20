// Read routes for the audit trail. Serves two NFRs: "authorization is deny-by-default" (both routes name
// audit.read) and "the trail is tamper-evident" (verify recomputes the hash chain on demand).
// Both routes read the caller's own tenant from ctx(); a tenant id is never taken from the request.
import { ChainVerifyDtoSchema } from '@bos/contracts';
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';

import { Can } from '../authz/decorators';
import { ctx, currentPrincipal } from '../tenancy/request-context';
import { AuditNewestFirstTooLargeError, AuditService } from './audit.service';
import { eventsVisibleTo } from './cost-redaction';

/** `?entityId=` (an empty value) means "not given", the same as leaving the parameter out. */
const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const isoInstant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const ListQuery = z
  .object({
    entityType: optional(z.string().min(1).max(200)),
    entityId: optional(z.string().min(1).max(200)),
    from: optional(isoInstant),
    to: optional(isoInstant),
    // A bigint id as a string. 18 digits always fit a Postgres bigint (19 could overflow into a 500).
    afterId: optional(z.string().regex(/^\d{1,18}$/)),
    // audit.read_events clamps to 1..500 as well; refusing here tells the caller instead of silently trimming.
    limit: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().min(1).max(500).default(50),
    ),
    // `desc` returns the newest `limit` events, newest first. Left out it is `asc`, the forward-paging order.
    order: optional(z.enum(['asc', 'desc'])),
  })
  // There is no backwards cursor: afterId pages forward only.
  .refine((q) => !(q.order === 'desc' && q.afterId !== undefined), {
    path: ['afterId'],
    message: 'afterId cannot be combined with order=desc',
  });

const VerifyQuery = z.object({ month: ChainVerifyDtoSchema.shape.month });

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
  }
  return parsed.data;
}

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Can('audit.read')
  async list(@Query() query: unknown) {
    const q = parse(ListQuery, query, 'query');
    const { tenantId, organizationId } = ctx();
    const items = await this.audit.list({ tenantId, organizationId }, q).catch((err: unknown) => {
      // Too many matches to find the newest: the caller narrows the filter, it is not a server fault.
      if (err instanceof AuditNewestFirstTooLargeError) throw new BadRequestException(err.message);
      throw err;
    });
    // Internal cost figures (D29) leave only with `quotation.cost.read`: the row stays, the figures do not.
    return { items: eventsVisibleTo(currentPrincipal(), items) };
  }

  /** Always the caller's own tenant: there is no tenant parameter to tamper with. */
  @Get('verify')
  @Can('audit.read')
  async verify(@Query() query: unknown) {
    const { month } = parse(VerifyQuery, query, 'query');
    return this.audit.verifyChain(ctx().tenantId, month);
  }
}
