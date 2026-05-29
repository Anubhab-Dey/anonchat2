package health

import "context"

type Checker interface {
	Ping(context.Context) error
}

func Ready(ctx context.Context, checker Checker) bool {
	return checker != nil && checker.Ping(ctx) == nil
}
