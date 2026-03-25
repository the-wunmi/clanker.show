import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";

export function useVoices() {
  return useQuery({
    queryKey: ["voices"],
    queryFn: api.fetchVoices,
    staleTime: 5 * 60 * 1000,
  });
}

export function useStations() {
  return useQuery({
    queryKey: ["stations"],
    queryFn: api.fetchStations,
  });
}

export function useStation(slug: string) {
  return useQuery({
    queryKey: ["station", slug],
    queryFn: () => api.fetchStation(slug),
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

export function useCreateStation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createStation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["stations"] }),
  });
}

export function useGenerateStationDraft() {
  return useMutation({
    mutationFn: api.generateStationDraft,
  });
}

export function useStartStation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.startStation(slug),
    onSuccess: (_, slug) =>
      queryClient.invalidateQueries({ queryKey: ["station", slug] }),
  });
}

export function useStopStation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.stopStation(slug),
    onSuccess: (_, slug) =>
      queryClient.invalidateQueries({ queryKey: ["station", slug] }),
  });
}

export function useSubmitCallIn(slug: string) {
  return useMutation({
    mutationFn: (data: { name: string; topicHint?: string }) =>
      api.submitCallIn(slug, data),
  });
}

export function useSubmitTip(slug: string) {
  return useMutation({
    mutationFn: (data: { name?: string; topic: string; content: string }) =>
      api.submitTip(slug, data),
  });
}
