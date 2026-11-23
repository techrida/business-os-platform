// The customer (and contact) a new lead is linked to when its company field was picked from the customers the
// caller may read (R6O, BOS-UI-002). The link is checked here, before anything is written:
// - "authorization is deny-by-default": the customer must be in the caller's tenant, not merged away, and readable
//   by them through the same can(principal, 'customer.read', ...) that GET /v1/customers/:id decides with. A
//   customer the caller may not read, one in another tenant and one that does not exist all answer the same 404, so a
//   lead cannot be used to probe for customers.
// - The contact must belong to that customer (400), the same wording the convert path uses.
import { customerContacts, customers } from '@bos/db';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { can, type Principal } from '../../platform/authz/can';
import { type DbTransaction, type TxScope } from '../../platform/db/tx';
import { customerRef } from '../customers/customers.service';

export async function assertLinkableCustomer(
  tx: DbTransaction,
  scope: TxScope,
  principal: Principal,
  customerId: string,
  contactId: string | undefined,
): Promise<void> {
  const [row] = await tx
    .select({ tenantId: customers.tenantId, id: customers.id, ownerUserId: customers.ownerUserId })
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, scope.tenantId),
        eq(customers.id, customerId),
        isNull(customers.mergedIntoId),
      ),
    );
  if (
    row === undefined ||
    principal.orgKind !== 'staff' ||
    !can(principal, 'customer.read', customerRef(row, principal)).allowed
  ) {
    throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });
  }
  if (contactId === undefined) return;
  const [contact] = await tx
    .select({ id: customerContacts.id })
    .from(customerContacts)
    .where(
      and(
        eq(customerContacts.tenantId, scope.tenantId),
        eq(customerContacts.customerId, customerId),
        eq(customerContacts.id, contactId),
      ),
    );
  if (contact === undefined) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'contactId is not a contact of this customer',
    });
  }
}
