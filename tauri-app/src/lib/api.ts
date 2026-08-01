import axios from 'axios';
import { getAccessToken, handleSessionExpired } from './authSession';

const DEFAULT_API_URL = import.meta.env.DEV
  ? 'http://localhost:3000'
  : 'https://api.agentree.app';

export const API_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL;

export const api = axios.create({
    baseURL: API_URL,
    withCredentials: true,
});

api.interceptors.request.use(async (config) => {
    const token = await getAccessToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

api.interceptors.response.use(
    (response) => response,
    async (error) => {
        if (!axios.isAxiosError(error)) {
            return Promise.reject(error);
        }

        const status = error.response?.status;
        const originalRequest = error.config as (typeof error.config & { _retry?: boolean }) | undefined;

        if (status === 401 && originalRequest && !originalRequest._retry) {
            originalRequest._retry = true;

            try {
                const refreshedToken = await getAccessToken({ forceRefresh: true });
                originalRequest.headers = originalRequest.headers ?? {};
                originalRequest.headers.Authorization = `Bearer ${refreshedToken}`;
                return api.request(originalRequest);
            } catch (refreshError) {
                await handleSessionExpired();
                return Promise.reject(refreshError);
            }
        }

        if (status === 401) {
            await handleSessionExpired();
        }

        return Promise.reject(error);
    }
);


export const getErrorMessage = (error: unknown): string => {
    if (axios.isAxiosError(error)) {
        return error.response?.data?.error || error.response?.data?.message || error.message || 'An API error occurred';
    } else if (error instanceof Error) {
        return error.message;
    }
    return 'An unknown error occurred';
};
