package engine

import (
	"errors"
	"fmt"
)

// ErrNotFound means the decision or key an action names does not exist.
var ErrNotFound = errors.New("not found")

// ConflictError means the action doesn't apply to the current state (e.g. hold already released).
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

func conflict(format string, a ...any) error { return &ConflictError{fmt.Sprintf(format, a...)} }

// ValidationError means the request is malformed whatever the state, such as an
// unknown outcome.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(msg string) error { return &ValidationError{msg} }
