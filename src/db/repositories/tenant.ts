/** Every repository method takes tenantId first and rejects empty values: no cross-tenant queries exist. */
export function assertTenant(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) throw new Error('tenantId is required');
}
