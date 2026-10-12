package api

import (
	"encoding/json"
	"net/http"
)

// Error codes returned in the "code" field of error responses.
const (
	codeNotFound         = "not_found"
	codeMethodNotAllowed = "method_not_allowed"
	codeInternal         = "internal"
	codeUnavailable      = "unavailable"
)

type errorResponse struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeJSON writes v as a JSON response with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	// The status line is already sent; an encoding failure can only be a
	// broken connection, so there is nothing useful left to do with it.
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes the standard error envelope {"error":{"code","message"}}.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorResponse{Error: errorDetail{Code: code, Message: message}})
}
