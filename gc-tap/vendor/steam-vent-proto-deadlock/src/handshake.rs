use crate::gcsdk_gcmessages::{CMsgClientHello, CMsgClientWelcome};

#[derive(PartialEq, Clone, Default, Debug)]
pub struct GCHandshake(CMsgClientHello);

impl steam_vent_proto_common::GCHandshake for GCHandshake {
    type Hello = CMsgClientHello;
    type Welcome = CMsgClientWelcome;

    fn app_id(&self) -> u32 {
        1422450
    }

    fn hello(&self) -> Self::Hello {
        self.0.clone()
    }
}
