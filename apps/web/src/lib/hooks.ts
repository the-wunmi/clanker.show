import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";

export function useVoices() {
  return useQuery({
    queryKey: ["voices"],
    queryFn: api.fetchVoices,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSpaces() {
  return useQuery({
    queryKey: ["spaces"],
    queryFn: api.fetchSpaces,
  });
}

export function useSpace(slug: string) {
  return useQuery({
    queryKey: ["space", slug],
    queryFn: () => api.fetchSpace(slug),
    enabled: !!slug,
  });
}

export function useStreamUrl(slug: string) {
  return useQuery({
    queryKey: ["stream-url", slug],
    queryFn: () => api.fetchStreamUrl(slug),
    enabled: !!slug,
    staleTime: Infinity,
  });
}

export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createSpace,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

export function useGenerateSpaceDraft() {
  return useMutation({
    mutationFn: api.generateSpaceDraft,
  });
}

export function useStartSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.startSpace(slug),
    onSuccess: (_, slug) =>
      queryClient.invalidateQueries({ queryKey: ["space", slug] }),
  });
}

export function useStopSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.stopSpace(slug),
    onSuccess: (_, slug) =>
      queryClient.invalidateQueries({ queryKey: ["space", slug] }),
  });
}

export function useSubmitCallIn(slug: string) {
  return useMutation({
    mutationFn: (data: { name: string; topicHint?: string }) =>
      api.submitCallIn(slug, data),
  });
}

export function useSubmitComment(slug: string) {
  return useMutation({
    mutationFn: (data: { name?: string; topic: string; content: string }) =>
      api.submitComment(slug, data),
  });
}
