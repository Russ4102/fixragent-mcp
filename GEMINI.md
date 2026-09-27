# fixRAgent

This extension connects the remote fixRAgent MCP server at `https://fixragent.com/mcp`.

Use `assess_property_photo` when the user has a photo of something in a building (an appliance, a boiler, a pipe, a water heater, an electrical panel, a leak, damage) and wants to know what it is, how urgent it is, and which trade to call. Pass the photo as base64 with its `mime_type`, and the problem in the reporter's own words as `problem_text` if you have it.

Do not use it for people, pets, injuries, vehicles, food, documents or screenshots. If something dangerous is happening right now (fire, a gas smell, a carbon-monoxide alarm, water on live electrics, anyone hurt), tell the user to leave and call 911 or the local emergency number first, and do not call the tool.

It routes the job. It does not price a repair, book a contractor or decide an insurance claim.

Assessing a photo needs a fixRAgent key (free at https://fixragent.com/docs#key). Set it with `gemini extensions config fixragent`.
