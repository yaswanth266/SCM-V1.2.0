import { useState } from 'react';
import api from '../../config/api';
import { App } from 'antd';

export const usePackagingApi = () => {
    const { message } = App.useApp();
    const fetchHierarchy = async (itemId) => {
        try {
            const { data } = await api.get(`/items/${itemId}/packaging`);
            return data;
        } catch (error) {
            message.error("Failed to fetch packaging hierarchy");
            return [];
        }
    };

    const saveHierarchy = async (itemId, payload) => {
        try {
            const { data } = await api.put(`/items/${itemId}/packaging`, payload);
            message.success("Packaging hierarchy saved successfully!");
            return data;
        } catch (error) {
            if (error.response?.status === 422) {
                message.error("Validation Error: Please check your inputs.");
            } else {
                message.error("An error occurred while saving.");
            }
            throw error;
        }
    };

    const fetchLevels = async () => {
        try {
            const { data } = await api.get('/packaging-levels');
            return data;
        } catch (error) {
            message.error("Failed to fetch container types");
            return [];
        }
    };

    const createLevel = async (payload) => {
        try {
            const { data } = await api.post('/packaging-levels', payload);
            message.success("Container type created successfully!");
            return data;
        } catch (error) {
            const errMsg = error.response?.data?.detail || "Failed to create container type";
            message.error(errMsg);
            throw error;
        }
    };

    const deleteLevel = async (levelId) => {
        try {
            await api.delete(`/packaging-levels/${levelId}`);
            message.success("Container type deleted successfully!");
        } catch (error) {
            const errMsg = error.response?.data?.detail || "Failed to delete container type";
            message.error(errMsg);
            throw error;
        }
    };

    return { fetchHierarchy, saveHierarchy, fetchLevels, createLevel, deleteLevel };
};

