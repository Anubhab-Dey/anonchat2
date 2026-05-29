package call

import "testing"

func TestManagerTransitions(t *testing.T) {
	manager := NewManager()
	started, err := manager.Start("call_1", "room", "video", "anon")
	if err != nil {
		t.Fatal(err)
	}
	if started.State != StateRinging {
		t.Fatalf("state = %s", started.State)
	}
	accepted, ok := manager.Transition("call_1", StateAccepted)
	if !ok || accepted.State != StateAccepted {
		t.Fatal("accept transition failed")
	}
}
