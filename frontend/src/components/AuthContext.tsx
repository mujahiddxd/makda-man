"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { registerUser, loginUser, getMe, githubLoginUrl, type User } from "@/lib/api";

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  register: (email: string, pass: string) => Promise<void>;
  logout: () => void;
  loginWithGitHub: () => void;
  githubError: string | null;
  openAuthModal: (mode?: "login" | "register") => void;
  closeAuthModal: () => void;
  isAuthModalOpen: boolean;
  modalMode: "login" | "register";
  setModalMode: (mode: "login" | "register") => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"login" | "register">("login");
  const [githubError, setGithubError] = useState<string | null>(null);

  useEffect(() => {
    // Returning from GitHub: the API redirects to /#github_token=<jwt> (or /#github_error=<message>).
    if (window.location.hash.includes("github_")) {
      const p = new URLSearchParams(window.location.hash.slice(1));
      const t = p.get("github_token");
      const e = p.get("github_error");
      if (t) localStorage.setItem("depexit_jwt", t);
      if (e) {
        setGithubError(e);
        setModalMode("login");
        setIsAuthModalOpen(true);
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const savedToken = localStorage.getItem("depexit_jwt");
    if (savedToken) {
      setToken(savedToken);
      getMe(savedToken)
        .then((u) => setUser(u))
        .catch(() => {
          localStorage.removeItem("depexit_jwt");
          setToken(null);
          setUser(null);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = async (email: string, pass: string) => {
    const res = await loginUser(email, pass);
    localStorage.setItem("depexit_jwt", res.token);
    setToken(res.token);
    setUser(res.user);
    setIsAuthModalOpen(false);
  };

  const register = async (email: string, pass: string) => {
    const res = await registerUser(email, pass);
    localStorage.setItem("depexit_jwt", res.token);
    setToken(res.token);
    setUser(res.user);
    setIsAuthModalOpen(false);
  };

  const logout = () => {
    localStorage.removeItem("depexit_jwt");
    setToken(null);
    setUser(null);
  };

  const loginWithGitHub = () => {
    setGithubError(null);
    window.location.href = githubLoginUrl();
  };

  const openAuthModal = (mode: "login" | "register" = "login") => {
    setModalMode(mode);
    setIsAuthModalOpen(true);
  };

  const closeAuthModal = () => {
    setIsAuthModalOpen(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        login,
        register,
        logout,
        loginWithGitHub,
        githubError,
        openAuthModal,
        closeAuthModal,
        isAuthModalOpen,
        modalMode,
        setModalMode,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
