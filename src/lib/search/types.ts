export type SearchResult = {
  title: string;
  url: string;
  description: string;
};

export type SearchProvider = {
  search(query: string, opts?: { count?: number }): Promise<SearchResult[]>;
  name: string;
};
