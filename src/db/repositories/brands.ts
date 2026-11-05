import type { Collection, Db } from 'mongodb';
import type { Brand } from '../../domain/types.js';
import { COLLECTIONS } from '../indexes.js';
import { assertTenant } from './tenant.js';

type StoredBrand = Brand & { tenantId: string };

export class BrandRepository {
  private readonly col: Collection<StoredBrand>;

  constructor(db: Db) {
    this.col = db.collection<StoredBrand>(COLLECTIONS.brands);
  }

  async listByTenant(tenantId: string): Promise<Brand[]> {
    assertTenant(tenantId);
    const rows = await this.col.find({ tenantId }).sort({ brandId: 1 }).toArray();
    return rows.map(({ brandId, name, aliases, exclusions }) => ({ brandId, name, aliases, exclusions }));
  }

  async upsert(tenantId: string, brand: Brand): Promise<void> {
    assertTenant(tenantId);
    await this.col.replaceOne({ tenantId, brandId: brand.brandId }, { tenantId, ...brand }, { upsert: true });
  }
}
