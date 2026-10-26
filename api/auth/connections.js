import {apiError,json,method,requireUser,sb} from "../_lib/runtime.js";
export default async function handler(req,res) {
  if (!method(req,res,["GET"])) return;
  try {
    const user=await requireUser(req);
    const rows=await sb("dexter_google_connections?select=role,email,scopes,connected_at,revoked_at&user_id=eq."+encodeURIComponent(user.id));
    return json(res,200,{connections:(rows||[]).map(r=>({role:r.role,email:r.email,scopes:r.scopes,connectedAt:r.connected_at,connected:!r.revoked_at}))});
  } catch(e) { return apiError(res,e); }
}
