import {
  perfId,
  scope,
  staff,
  vendor,
  department,
  PerfDataError,
  type PoolClient,
} from './company';

export async function seedPlatformPortal(
  c: PoolClient,
  portalOrgs: { customer_user: string; vendor_user: string },
  subjects: Record<string, string>,
) {
  if (!subjects['customer_user'] || !subjects['vendor_user'])
    throw new PerfDataError('Missing portal subjects');
  const t = scope.tenantId,
    o = scope.organizationId;
  for (const role of ['customer_user', 'vendor_user'] as const) {
    const isCustomer = role === 'customer_user';
    const org = perfId(isCustomer ? 'portal-org-0' : 'vendor-portal-org');
    const user = perfId(isCustomer ? 'portal-user-0' : 'vendor-portal-user');
    if (!isCustomer) {
      await c.query(
        "INSERT INTO app.idp_orgs(id,tenant_id,zitadel_org_id,kind,party_id,name) VALUES($1,$2,$3,'vendor',$4,'Perf Vendor') ON CONFLICT (id) DO NOTHING",
        [org, t, portalOrgs[role], vendor],
      );
      await c.query(
        "INSERT INTO app.users(id,tenant_id,idp_org_id,zitadel_user_id,email,display_name,status) VALUES($1,$2,$3,$4,'vendor@perf.invalid','Perf Vendor','active') ON CONFLICT (id) DO NOTHING",
        [user, t, org, subjects[role]],
      );
    }
    await c.query(
      'UPDATE app.idp_orgs SET zitadel_org_id=$3 WHERE id=$1 AND tenant_id=$2 AND zitadel_org_id<>$3',
      [org, t, portalOrgs[role]],
    );
    await c.query(
      'UPDATE app.users SET zitadel_user_id=$3 WHERE id=$1 AND tenant_id=$2 AND zitadel_user_id<>$3',
      [user, t, subjects[role]],
    );
  }
  const pr = perfId('platform-pr'),
    rfq = perfId('platform-rfq');
  await c.query(
    "INSERT INTO app.cost_centers(id,tenant_id,organization_id,code,name) VALUES($1,$2,$3,'PERF-Q','Perf sourcing') ON CONFLICT DO NOTHING",
    [perfId('cost-center'), t, o],
  );
  await c.query(
    "INSERT INTO app.purchase_requests(id,tenant_id,organization_id,request_type,department_id,requester_user_id,cost_center_id,justification,required_by,budget_code,status,fx_rate,estimated_total_npr) VALUES($1,$2,$3,'goods',$4,$5,$6,'Perf vendor quote',current_date+30,'PERF','sourcing',1,0) ON CONFLICT (id) DO NOTHING",
    [pr, t, o, department, staff.procurement, perfId('cost-center')],
  );
  await c.query(
    "INSERT INTO app.rfqs(id,tenant_id,organization_id,purchase_request_id,number,deadline,created_by) VALUES($1,$2,$3,$4,'PERF-RFQ',now()+interval '30 days',$5) ON CONFLICT (id) DO NOTHING",
    [rfq, t, o, pr, staff.procurement],
  );
  await c.query(
    'INSERT INTO app.rfq_vendors(tenant_id,organization_id,rfq_id,vendor_id,invited_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [t, o, rfq, vendor, staff.procurement],
  );
}
