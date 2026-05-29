package presence

func CleanStatus(value string) string {
	switch value {
	case "away", "busy":
		return value
	default:
		return "online"
	}
}
