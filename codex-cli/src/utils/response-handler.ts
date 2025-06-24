export interface JsonResponse {
  overview: string;
  file_structure: Record<string, unknown>;
  analysis: string;
  errors: Array<string>;
  status: string;
}

export function initializeJsonResponse(): JsonResponse {
  return {
    overview: "",
    file_structure: {},
    analysis: "",
    errors: [],
    status: "in_progress",
  };
}
