import type { CostCenter } from '@bos/contracts';
import { Controller, Get } from '@nestjs/common';

import { AnyAuthenticated } from '../../../platform/authz/decorators';
import { CostCentersService } from './cost-centers.service';

@Controller('v1/cost-centers')
export class CostCentersController {
  constructor(private readonly costCenters: CostCentersService) {}

  @Get()
  @AnyAuthenticated()
  list(): Promise<CostCenter[]> {
    return this.costCenters.list();
  }
}
