// Drag APIs use two pagination patterns:
//   v2: page-based (page, limit)
//   v1.18: varies — some use offset-based (offset, count), some use page-based
//
// We normalise both to a consistent interface for tool inputs.

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface OffsetPaginationParams {
  offset?: number;
  count?: number;
}

/** Build query params for v2 page-based pagination */
export function withPagination(params: PaginationParams = {}): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (params.page !== undefined) result.page = params.page;
  if (params.limit !== undefined) result.limit = params.limit;
  return result;
}

/** Build query params for v1.18 offset-based pagination */
export function withOffsetPagination(params: OffsetPaginationParams = {}): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (params.offset !== undefined) result.offset = params.offset;
  if (params.count !== undefined) result.count = params.count;
  return result;
}
