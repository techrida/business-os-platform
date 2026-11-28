// HTTP latency limits in milliseconds, keyed by the wave 2 flow names.
export const platformLimits = {
  'open-inbox': 600,
  'upload-document': 80,
  'scan-document': 600,
  'save-access-policy': 80,
  'save-approval-workflow': 80,
  'filter-audit-trail': 600,
  'portal-invoices': 600,
  'portal-submit-quotation': 80,
  'sidebar-navigation': 600,
};
