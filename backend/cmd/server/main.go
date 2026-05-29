package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"anonchat2/backend/internal/config"
	httpapi "anonchat2/backend/internal/http"
	"anonchat2/backend/internal/logger"
	"anonchat2/backend/internal/ratelimit"
	"anonchat2/backend/internal/realtime"
	"anonchat2/backend/internal/session"
	"anonchat2/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := logger.New(cfg.LogLevel, cfg.DevMode)
	slog.SetDefault(log)

	db, err := store.Open(cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()

	if err := db.Migrate(context.Background()); err != nil {
		return err
	}

	sessionService := session.NewService(session.Options{
		Store:      db,
		CookieName: cfg.SessionCookieName,
		Secret:     cfg.SessionSecret,
		DevMode:    cfg.DevMode,
	})

	limits := ratelimit.New()
	hub := realtime.NewHub(realtime.Options{
		Logger:      log,
		Store:       db,
		RateLimiter: limits,
	})
	go hub.Run()
	defer hub.Shutdown()

	router := httpapi.NewRouter(httpapi.RouterOptions{
		Config:   cfg,
		Logger:   log,
		Store:    db,
		Sessions: sessionService,
		Hub:      hub,
	})

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		log.Info("anonchat2 listening", "addr", cfg.HTTPAddr)
		errs <- server.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-stop:
		log.Info("shutdown requested", "signal", sig.String())
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		return err
	}

	return nil
}
