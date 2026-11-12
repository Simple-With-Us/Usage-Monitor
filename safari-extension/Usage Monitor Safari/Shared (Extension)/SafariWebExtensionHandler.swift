//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Jay Wedgeworth on 7/21/26.
//

import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        // This extension is only a launcher. Do not inspect or echo browser content.
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        } else {
            response.userInfo = ["message": ["ok": true]]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

}
